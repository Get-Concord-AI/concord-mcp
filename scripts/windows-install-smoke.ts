/**
 * Windows install smoke. `pnpm e2e` shells out through `/bin/sh` and its job
 * never runs on Windows, so it cannot see the npm `.cmd` shim.
 *
 * Packs this repo the way a release does, installs that tarball into a throwaway
 * prefix, and launches `concord` through `concord.cmd`. Then it runs the Cursor
 * relay session-start hook, which spawns `concord` itself, and checks that the
 * agent actually got registered.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_PHASE = 'PACK';
const INSTALL_PHASE = 'INSTALL';
const SHIM_PHASE = 'SHIM';
const VERSION_PHASE = 'VERSION';
const HOOK_PHASE = 'HOOK';
/** Session id shape from test/e2e/drivers/cursor.ts. */
const SMOKE_SESSION = 'windows-smoke';
const NPM_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 60_000;

const packageSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
});

/** What `cursor-hook.mjs` session-start prints after a real registration. `{}` fails this. */
const hookOutputSchema = z.object({
  env: z.object({
    CONCORD_AGENT_ID: z.string().min(1),
  }),
  additional_context: z.string().min(1),
});

interface PackageManifest {
  name: string;
  version: string;
}

interface Layout {
  root: string;
  home: string;
  prefix: string;
  packDir: string;
  repo: string;
  npmCache: string;
  /** `cursorTarget` in src/install/adapters/links.ts, under the temp home. */
  junction: string;
}

interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | undefined;
}

class SmokeFailure extends Error {
  constructor(phase: string) {
    super(phase);
    this.name = 'SmokeFailure';
  }
}

function pass(phase: string, extra?: string): void {
  console.log(extra === undefined ? `${phase} PASS` : `${phase} PASS ${extra}`);
}

function fail(phase: string, detail: string): never {
  console.log(`${phase} FAIL`);
  console.log(detail);
  throw new SmokeFailure(phase);
}

function readPackage(path: string): PackageManifest {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return packageSchema.parse(raw);
}

/** Same agent id as plugin/cursor/concord-relay/cursor-hook.mjs `agentIdFor`. */
function cursorAgentId(sessionId: string): string {
  return `cursor:${createHash('sha256').update(sessionId).digest('hex').slice(0, 8)}`;
}

/** Same quoting as plugin/spawn-command.mjs, so `npm.cmd` runs without a shell. */
function quoteCmdArgument(value: string): string {
  if (value.length === 0) return '""';
  const escaped = value.replaceAll('%', '%%cd:~,%').replaceAll('"', '""');
  if (value !== escaped || /[\s"&|<>^]/u.test(value)) return `"${escaped}"`;
  return value;
}

/** SpawnSync types stdout as a string; a failed spawn can still return null. */
function asText(value: string | null): string {
  return value ?? '';
}

function run(
  file: string,
  args: readonly string[],
  options: RunOptions,
  windowsVerbatimArguments = false,
): CommandResult {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    windowsVerbatimArguments,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return {
    status: result.status,
    stdout: asText(result.stdout),
    stderr: asText(result.stderr),
    error: result.error?.message,
  };
}

function runBatch(file: string, args: readonly string[], options: RunOptions): CommandResult {
  const inner = [quoteCmdArgument(file), ...args.map((arg) => quoteCmdArgument(arg))].join(' ');
  return run('cmd.exe', ['/d', '/v:off', '/s', '/c', `"${inner}"`], options, true);
}

/** PowerShell would pick `concord.ps1`. `cmd.exe /d /s /c "concord.cmd …"` does not. */
function runConcord(phase: string, args: readonly string[], options: RunOptions): CommandResult {
  if (args.some((arg) => /[\s"&|<>^%]/u.test(arg))) {
    fail(phase, `refusing to quote concord arguments: ${args.join(' ')}`);
  }
  return run('cmd.exe', ['/d', '/s', '/c', ['concord.cmd', ...args].join(' ')], options);
}

function commandText(command: string, result: CommandResult): string {
  const lines = [`$ ${command}`, `exit ${String(result.status)}`];
  if (result.error !== undefined) lines.push(result.error);
  if (result.stdout.trim() !== '') lines.push(result.stdout.trimEnd());
  if (result.stderr.trim() !== '') lines.push(result.stderr.trimEnd());
  return lines.join('\n');
}

function requireSuccess(phase: string, command: string, result: CommandResult): string {
  if (result.error !== undefined || result.status !== 0) {
    fail(phase, `${command} failed\n${commandText(command, result)}`);
  }
  return result.stdout;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined || left.trim() === '' || right.trim() === '') {
    return false;
  }
  const normalize = (value: string): string =>
    resolve(value)
      .replace(/[\\/]+$/u, '')
      .toLowerCase();
  return normalize(left) === normalize(right);
}

function isInside(file: string, directory: string): boolean {
  const parent = resolve(directory)
    .replace(/[\\/]+$/u, '')
    .toLowerCase();
  const child = resolve(file).toLowerCase();
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== 'path') continue;
    const value = env[key];
    if (value === undefined) continue;
    for (const entry of value.split(';')) {
      const trimmed = entry.trim();
      if (trimmed === '') continue;
      const marker = trimmed.replace(/[\\/]+$/u, '').toLowerCase();
      if (seen.has(marker)) continue;
      seen.add(marker);
      entries.push(trimmed);
    }
  }
  return entries;
}

function firstPathEntry(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== 'path') continue;
    const value = env[key];
    if (value === undefined) continue;
    return value
      .split(';')
      .find((entry) => entry.trim() !== '')
      ?.trim();
  }
  return undefined;
}

function setEnv(env: NodeJS.ProcessEnv, name: string, value: string): void {
  const wanted = name.toLowerCase();
  let found = false;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== wanted) continue;
    env[key] = value;
    found = true;
  }
  if (!found) env[name] = value;
}

/**
 * Child environment. HOME, USERPROFILE, APPDATA, and LOCALAPPDATA all point at
 * the temp home: telemetry identity is stored under APPDATA on Windows
 * (src/telemetry/identity.ts), not under HOME. The real `%APPDATA%\npm` bin is
 * removed so a machine-wide `concord` cannot satisfy `where`.
 */
function smokeEnvironment(layout: Layout): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const realAppData = process.env['APPDATA'];
  const realNpmBin =
    realAppData === undefined || realAppData.trim() === '' ? undefined : join(realAppData, 'npm');
  const kept = pathEntries(process.env).filter(
    (entry) => !samePath(entry, realNpmBin) && !samePath(entry, layout.prefix),
  );
  setEnv(env, 'PATH', [layout.prefix, ...kept].join(';'));
  setEnv(env, 'HOME', layout.home);
  setEnv(env, 'USERPROFILE', layout.home);
  setEnv(env, 'APPDATA', join(layout.home, 'AppData', 'Roaming'));
  setEnv(env, 'LOCALAPPDATA', join(layout.home, 'AppData', 'Local'));
  setEnv(env, 'XDG_CACHE_HOME', join(layout.home, 'cache'));
  setEnv(env, 'XDG_CONFIG_HOME', join(layout.home, 'config'));
  setEnv(env, 'npm_config_prefix', layout.prefix);
  setEnv(env, 'npm_config_cache', layout.npmCache);
  setEnv(env, 'CONCORD_TELEMETRY_DISABLED', '1');
  setEnv(env, 'CONCORD_NO_UPDATE_CHECK', '1');
  return env;
}

function createLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), 'concord-windows-smoke-'));
  const home = join(root, 'home');
  const directories = [
    home,
    join(home, 'AppData', 'Roaming'),
    join(home, 'AppData', 'Local'),
    join(home, 'cache'),
    join(home, 'config'),
    join(root, 'prefix'),
    join(root, 'pack'),
    join(root, 'repo'),
    join(root, 'npm-cache'),
  ];
  for (const directory of directories) mkdirSync(directory, { recursive: true });
  return {
    root,
    home,
    prefix: join(root, 'prefix'),
    packDir: join(root, 'pack'),
    repo: join(root, 'repo'),
    npmCache: join(root, 'npm-cache'),
    junction: join(home, '.cursor', 'extensions', 'get-concord-ai.concord-relay'),
  };
}

function cleanup(layout: Layout): void {
  // rmSync removes the junction itself and leaves its target. The target is
  // inside layout.root, which goes next.
  if (existsSync(layout.junction)) rmSync(layout.junction, { recursive: true, force: true });
  try {
    rmSync(layout.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.log(
      `cleanup failed for ${layout.root}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

function pack(layout: Layout, env: NodeJS.ProcessEnv): string {
  const entry = join(REPO_ROOT, 'dist', 'cli', 'index.js');
  if (!existsSync(entry)) {
    fail(
      PACK_PHASE,
      'dist/cli/index.js is missing. Build the package before the Windows install smoke.',
    );
  }
  const command = `npm pack --pack-destination ${layout.packDir} --ignore-scripts`;
  const result = runBatch(
    'npm.cmd',
    ['pack', '--pack-destination', layout.packDir, '--ignore-scripts'],
    { cwd: REPO_ROOT, env, timeoutMs: NPM_TIMEOUT_MS },
  );
  requireSuccess(PACK_PHASE, command, result);
  const names = readdirSync(layout.packDir).filter((name) => name.endsWith('.tgz'));
  const name = names.length === 1 ? names[0] : undefined;
  if (name === undefined) {
    fail(PACK_PHASE, `expected one tarball in ${layout.packDir}, found ${String(names.length)}`);
  }
  pass(PACK_PHASE);
  return join(layout.packDir, name);
}

function install(
  layout: Layout,
  env: NodeJS.ProcessEnv,
  pkg: PackageManifest,
  tarball: string,
): string {
  const command = `npm install --global --prefix ${layout.prefix} ${tarball}`;
  const result = runBatch(
    'npm.cmd',
    ['install', '--global', '--prefix', layout.prefix, '--no-audit', '--no-fund', tarball],
    { cwd: layout.root, env, timeoutMs: NPM_TIMEOUT_MS },
  );
  requireSuccess(INSTALL_PHASE, command, result);
  const packageDir = join(layout.prefix, 'node_modules', ...pkg.name.split('/'));
  const manifest = join(packageDir, 'package.json');
  if (!existsSync(manifest)) fail(INSTALL_PHASE, `npm install did not write ${manifest}`);
  const installed = readPackage(manifest);
  if (installed.version !== pkg.version) {
    fail(INSTALL_PHASE, `installed ${installed.version}, but package.json says ${pkg.version}`);
  }
  pass(INSTALL_PHASE);
  return packageDir;
}

function whereConcord(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const result = run('where.exe', ['concord'], { cwd, env, timeoutMs: 15_000 });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function assertShim(layout: Layout, env: NodeJS.ProcessEnv): void {
  const shim = join(layout.prefix, 'concord.cmd');
  if (!existsSync(shim)) {
    fail(
      SHIM_PHASE,
      `npm install exited 0 but ${shim} does not exist. A missing package bin target does not fail the install.`,
    );
  }
  const first = firstPathEntry(env);
  if (!samePath(first, layout.prefix)) {
    fail(SHIM_PHASE, `temp prefix is not first on PATH (first entry: ${first ?? '(none)'})`);
  }
  const found = whereConcord(env, layout.root);
  if (found.length === 0) fail(SHIM_PHASE, '`where concord` found nothing on the smoke PATH.');
  const outside = found.filter((entry) => !isInside(entry, layout.prefix));
  if (outside.length > 0) {
    fail(
      SHIM_PHASE,
      `where concord resolved outside the temp prefix:\n${outside.join('\n')}\nall results:\n${found.join('\n')}`,
    );
  }
  pass(SHIM_PHASE);
}

function assertVersion(env: NodeJS.ProcessEnv, version: string, cwd: string): void {
  const command = 'cmd.exe /d /s /c "concord.cmd --version"';
  const result = runConcord(VERSION_PHASE, ['--version'], { cwd, env });
  const stdout = requireSuccess(VERSION_PHASE, command, result).trim();
  if (stdout !== version) {
    fail(
      VERSION_PHASE,
      `expected ${version} from concord.cmd --version, got ${JSON.stringify(stdout)}`,
    );
  }
  pass(VERSION_PHASE, version);
}

function linkCursorRelay(layout: Layout, packageDir: string): void {
  // installLink() in src/install/adapters/links.ts writes this same junction
  // (symlinkSync(..., 'junction') on win32) at cursorTarget(). Calling it from
  // here would import the unbuilt TS graph, and it also refuses to point a
  // lasting home at a temp prefix. The source is the packed plugin, so the
  // hook loads the packed spawn-command.mjs and then resolves `concord` on PATH.
  const source = join(packageDir, 'plugin', 'cursor', 'concord-relay');
  if (!existsSync(join(source, 'cursor-hook.mjs'))) {
    fail(HOOK_PHASE, `packed Cursor relay is missing ${join(source, 'cursor-hook.mjs')}`);
  }
  mkdirSync(dirname(layout.junction), { recursive: true });
  symlinkSync(source, layout.junction, 'junction');
}

function assertHook(layout: Layout, env: NodeJS.ProcessEnv, packageDir: string): void {
  const init = run('git', ['init', '-q', layout.repo], { cwd: layout.root, env });
  requireSuccess(HOOK_PHASE, 'git init -q <repo>', init);

  const setup = runConcord(HOOK_PHASE, ['setup', '--no-mcp', '--no-adapters'], {
    cwd: layout.repo,
    env,
    timeoutMs: NPM_TIMEOUT_MS,
  });
  requireSuccess(HOOK_PHASE, 'cmd.exe /d /s /c "concord.cmd setup --no-mcp --no-adapters"', setup);
  const database = join(layout.repo, '.concord', 'concord.db');
  if (!existsSync(database)) {
    fail(HOOK_PHASE, `setup did not create ${database}\n${setup.stdout}\n${setup.stderr}`);
  }

  linkCursorRelay(layout, packageDir);
  const hookScript = join(layout.junction, 'cursor-hook.mjs');
  const payload = JSON.stringify({
    conversation_id: SMOKE_SESSION,
    generation_id: `${SMOKE_SESSION}-gen`,
    hook_event_name: 'sessionStart',
    workspace_roots: [layout.repo],
  });
  const hook = run(process.execPath, [hookScript, 'session-start'], {
    cwd: layout.repo,
    env,
    input: payload,
  });
  requireSuccess(HOOK_PHASE, `node ${hookScript} session-start`, hook);

  let parsed: ReturnType<typeof hookOutputSchema.safeParse>;
  try {
    const raw: unknown = JSON.parse(hook.stdout);
    parsed = hookOutputSchema.safeParse(raw);
  } catch {
    fail(HOOK_PHASE, `session-start did not print JSON\n${hook.stdout}`);
  }
  if (!parsed.success) {
    fail(
      HOOK_PHASE,
      `session-start did not register an agent. When concord cannot be spawned and the directory is not a workspace, the hook prints {} and exits 0.\n${parsed.error.message}\n${hook.stdout}`,
    );
  }
  const agentId = parsed.data.env.CONCORD_AGENT_ID;
  const expected = cursorAgentId(SMOKE_SESSION);
  if (agentId !== expected) {
    fail(
      HOOK_PHASE,
      `session-start registered ${agentId}, expected ${expected} for session ${SMOKE_SESSION}`,
    );
  }

  const who = runConcord(HOOK_PHASE, ['who'], { cwd: layout.repo, env });
  const whoStdout = requireSuccess(HOOK_PHASE, 'cmd.exe /d /s /c "concord.cmd who"', who);
  if (!whoStdout.includes(agentId)) {
    fail(HOOK_PHASE, `concord.cmd who did not list ${agentId}\n${whoStdout}`);
  }
  pass(HOOK_PHASE, agentId);
}

function runSmoke(layout: Layout): void {
  const pkg = readPackage(join(REPO_ROOT, 'package.json'));
  const env = smokeEnvironment(layout);
  const tarball = pack(layout, env);
  const packageDir = install(layout, env, pkg, tarball);
  assertShim(layout, env);
  assertVersion(env, pkg.version, layout.root);
  assertHook(layout, env, packageDir);
}

function main(): void {
  if (process.platform !== 'win32') {
    console.log(`${PACK_PHASE} FAIL`);
    console.log('Windows install smoke runs only on win32.');
    process.exitCode = 1;
    return;
  }
  const layout = createLayout();
  try {
    runSmoke(layout);
  } catch (error) {
    if (!(error instanceof SmokeFailure)) {
      console.log('FAIL');
      console.log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    process.exitCode = 1;
  } finally {
    cleanup(layout);
  }
}

main();
