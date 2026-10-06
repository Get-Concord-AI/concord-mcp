import { spawnSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HARNESS_CONFIGS,
  type HarnessName,
  type MonitorKind,
} from '../../domain/harness-config.js';
import { userHome } from '../../config/paths.js';
import { claudeSkillsPluginPath } from '../claude-plugin.js';
import { installCodexHooks, installCodexMcpConfig, uninstallCodexConfig } from '../codex-config.js';

export type { HarnessName, MonitorKind } from '../../domain/harness-config.js';
export type AdapterStatus =
  'installed' | 'not_detected' | 'action_required' | 'unsupported_version' | 'error';

export interface AdapterReport {
  harness: HarnessName;
  detected: boolean;
  status: AdapterStatus;
  monitor: MonitorKind;
  capabilities: string[];
  detail: string;
  installedPath?: string | undefined;
}

function executablePath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env['PATH'];
  if (path === undefined) return undefined;
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of path.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function packagedPath(moduleUrl: string, parts: readonly string[]): string | undefined {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 7; depth += 1) {
    const candidate = join(directory, ...parts);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function installLink(source: string, target: string): 'installed' | 'occupied' {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target) || isSymlink(target)) {
    if (!isSymlink(target)) return 'occupied';
    if (readlinkSync(target) === source) return 'installed';
    rmSync(target);
  }
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  return 'installed';
}

function hasConcordManifest(path: string): boolean {
  const manifests = [
    join(path, '.claude-plugin', 'plugin.json'),
    join(path, 'gemini-extension.json'),
    join(path, 'package.json'),
  ];
  return manifests.some((manifest) => {
    try {
      return readFileSync(manifest, 'utf8').includes('concord-relay');
    } catch {
      return false;
    }
  });
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): {
  ok: boolean;
  output: string;
} {
  const result = spawnSync(command, [...args], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

function versionTuple(output: string): number[] | undefined {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/u.exec(output);
  if (match === null) return undefined;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function atLeast(actual: readonly number[], required: readonly number[]): boolean {
  for (let index = 0; index < required.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function installedLinkReport(
  harness: HarnessName,
  detected: boolean,
  monitor: MonitorKind,
  target: string,
  capabilities: string[],
  detail: string,
): AdapterReport {
  const installed = existsSync(target) && hasConcordManifest(target);
  return {
    harness,
    detected,
    status: installed ? 'installed' : detected ? 'action_required' : 'not_detected',
    monitor,
    capabilities,
    detail,
    ...(installed ? { installedPath: target } : {}),
  };
}

function statusClaude(env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS['claude-code'];
  const executable = executablePath(config.executable, env);
  const target = claudeSkillsPluginPath(env);
  if (executable !== undefined) {
    const version = versionTuple(run(executable, ['--version'], env).output);
    if (version === undefined || !atLeast(version, config.minimumVersion)) {
      return {
        harness: config.name,
        detected: true,
        status: 'unsupported_version',
        monitor: config.monitor.kind,
        capabilities: ['steer', 'busy'],
        detail: config.unsupportedDetail,
      };
    }
  }
  return installedLinkReport(
    config.name,
    executable !== undefined,
    config.monitor.kind,
    target,
    [...config.installedCapabilities],
    config.installedDetail,
  );
}

function statusCodex(env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS.codex;
  const executable = executablePath(config.executable, env);
  if (executable === undefined) {
    return {
      harness: config.name,
      detected: false,
      status: 'not_detected',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: 'Codex CLI was not found on PATH.',
    };
  }
  const version = run(executable, ['--version'], env);
  const tuple = versionTuple(version.output);
  if (tuple === undefined || !atLeast(tuple, config.minimumVersion)) {
    return {
      harness: config.name,
      detected: true,
      status: 'unsupported_version',
      monitor: config.monitor.kind,
      capabilities: ['pull', 'busy'],
      detail: `Codex ${version.output || '(unknown version)'} lacks the verified app-server steering contract.`,
    };
  }
  const daemon = run(executable, ['app-server', 'daemon', 'version'], env);
  return {
    harness: config.name,
    detected: true,
    status: daemon.ok ? 'installed' : 'action_required',
    monitor: config.monitor.kind,
    capabilities: daemon.ok ? [...config.installedCapabilities] : ['pull', 'busy'],
    detail: daemon.ok
      ? config.installedDetail
      : 'Global hooks are installed, but the managed app-server daemon is not ready.',
  };
}

function geminiTarget(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.gemini', 'extensions', 'concord-relay');
}

function cursorTarget(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.cursor', 'extensions', 'get-concord-ai.concord-relay');
}

const CURSOR_HOOKS = {
  sessionStart: {
    command:
      'node "$HOME/.cursor/extensions/get-concord-ai.concord-relay/cursor-hook.mjs" session-start',
    timeout: 15,
  },
  stop: {
    command: 'node "$HOME/.cursor/extensions/get-concord-ai.concord-relay/cursor-hook.mjs" stop',
    timeout: 15,
    loop_limit: 25,
  },
  sessionEnd: {
    command:
      'node "$HOME/.cursor/extensions/get-concord-ai.concord-relay/cursor-hook.mjs" session-end',
    timeout: 15,
  },
} as const;

function cursorHooksPath(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.cursor', 'hooks.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return parsed;
}

function cursorHookInstalled(env: NodeJS.ProcessEnv): boolean {
  try {
    const config = readJsonObject(cursorHooksPath(env));
    const hooks = config['hooks'];
    if (!isRecord(hooks)) return false;
    return Object.entries(CURSOR_HOOKS).every(([event, expected]) => {
      const definitions = hooks[event];
      return (
        Array.isArray(definitions) &&
        definitions.some(
          (definition) => isRecord(definition) && definition['command'] === expected.command,
        )
      );
    });
  } catch {
    return false;
  }
}

function installCursorHooks(env: NodeJS.ProcessEnv): void {
  const path = cursorHooksPath(env);
  const config = readJsonObject(path);
  const currentHooks = isRecord(config['hooks']) ? config['hooks'] : {};
  const nextHooks: Record<string, unknown> = { ...currentHooks };
  for (const [event, expected] of Object.entries(CURSOR_HOOKS)) {
    const currentValue: unknown = currentHooks[event];
    const current: unknown[] = Array.isArray(currentValue) ? currentValue : [];
    const retained = current.filter(
      (definition) => !isRecord(definition) || definition['command'] !== expected.command,
    );
    nextHooks[event] = [...retained, expected];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...config, version: 1, hooks: nextHooks }, null, 2)}\n`, {
    mode: 0o600,
  });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function uninstallCursorHooks(env: NodeJS.ProcessEnv): void {
  const path = cursorHooksPath(env);
  if (!existsSync(path)) return;
  const config = readJsonObject(path);
  const currentHooks = config['hooks'];
  if (!isRecord(currentHooks)) return;
  const nextHooks: Record<string, unknown> = { ...currentHooks };
  for (const [event, expected] of Object.entries(CURSOR_HOOKS)) {
    const current = currentHooks[event];
    if (!Array.isArray(current)) continue;
    nextHooks[event] = current.filter(
      (definition) => !isRecord(definition) || definition['command'] !== expected.command,
    );
  }
  writeFileSync(path, `${JSON.stringify({ ...config, hooks: nextHooks }, null, 2)}\n`, {
    mode: 0o600,
  });
}

function geminiCompletionInjectionReady(repoRoot: string): boolean {
  try {
    const settings = readJsonObject(join(repoRoot, '.gemini', 'settings.json'));
    const tools = settings['tools'];
    if (!isRecord(tools)) return false;
    const shell = tools['shell'];
    const experimental = settings['experimental'];
    return (
      isRecord(shell) &&
      shell['backgroundCompletionBehavior'] === 'inject' &&
      isRecord(experimental) &&
      experimental['modelSteering'] === true
    );
  } catch {
    return false;
  }
}

function statusGemini(env: NodeJS.ProcessEnv, repoRoot?: string): AdapterReport {
  const config = HARNESS_CONFIGS.gemini;
  const executable = executablePath(config.executable, env);
  if (executable !== undefined) {
    const version = versionTuple(run(executable, ['--version'], env).output);
    if (version === undefined || !atLeast(version, config.minimumVersion)) {
      return {
        harness: config.name,
        detected: true,
        status: 'unsupported_version',
        monitor: config.monitor.kind,
        capabilities: [],
        detail: config.unsupportedDetail,
      };
    }
  }
  const installed = installedLinkReport(
    config.name,
    executable !== undefined,
    config.monitor.kind,
    geminiTarget(env),
    [...config.installedCapabilities],
    config.installedDetail,
  );
  if (
    installed.status !== 'installed' ||
    repoRoot === undefined ||
    geminiCompletionInjectionReady(repoRoot)
  ) {
    return installed;
  }
  return {
    ...installed,
    status: 'action_required',
    capabilities: ['pull', 'steer', 'busy'],
    detail:
      'The Gemini extension is installed, but this project is missing ' +
      'tools.shell.backgroundCompletionBehavior = "inject" or ' +
      'experimental.modelSteering = true. Run `concord setup` in the project.',
  };
}

function statusCursor(env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS.cursor;
  const target = cursorTarget(env);
  const executable = executablePath(config.executable, env);
  const detected = executable !== undefined;
  const extensionInstalled = hasConcordManifest(target);
  const hooksInstalled = cursorHookInstalled(env);
  if (executable !== undefined) {
    const version = versionTuple(run(executable, ['--version'], env).output);
    if (version === undefined || !atLeast(version, config.minimumVersion)) {
      return {
        harness: config.name,
        detected: true,
        status: 'unsupported_version',
        monitor: config.monitor.kind,
        capabilities: [],
        detail: config.unsupportedDetail,
        ...(extensionInstalled ? { installedPath: target } : {}),
      };
    }
  }
  const installed = extensionInstalled && hooksInstalled;
  return {
    harness: config.name,
    detected,
    status: installed
      ? 'installed'
      : detected || extensionInstalled
        ? 'action_required'
        : 'not_detected',
    monitor: config.monitor.kind,
    capabilities: installed ? [...config.installedCapabilities] : [],
    detail: installed
      ? config.installedDetail
      : 'The Cursor extension and global lifecycle hooks are not both installed.',
    ...(extensionInstalled ? { installedPath: target } : {}),
  };
}

function statusGrok(env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS.grok;
  const executable = executablePath(config.executable, env);
  if (executable === undefined) {
    return {
      harness: config.name,
      detected: false,
      status: 'not_detected',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: 'Grok Build was not found on PATH.',
    };
  }
  const version = versionTuple(run(executable, ['--version'], env).output);
  if (version === undefined || !atLeast(version, config.minimumVersion)) {
    return {
      harness: config.name,
      detected: true,
      status: 'unsupported_version',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: config.unsupportedDetail,
    };
  }
  const listed = run(executable, ['plugin', 'list', '--json'], env);
  const installed = listed.ok && listed.output.includes('concord-relay');
  return {
    harness: config.name,
    detected: true,
    status: installed ? 'installed' : 'action_required',
    monitor: config.monitor.kind,
    capabilities: installed ? [...config.installedCapabilities] : [],
    detail: installed ? config.installedDetail : 'The Grok plugin is not installed or trusted.',
  };
}

export function statusGlobalAdapters(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
): AdapterReport[] {
  return [
    statusClaude(env),
    statusCodex(env),
    statusCursor(env),
    statusGemini(env, repoRoot),
    statusGrok(env),
  ];
}

function installPackagedLink(
  moduleUrl: string,
  parts: readonly string[],
  target: string,
): 'installed' | 'occupied' | 'missing' {
  const source = packagedPath(moduleUrl, parts);
  return source === undefined ? 'missing' : installLink(source, target);
}

function requirePackagedLink(moduleUrl: string, parts: readonly string[], target: string): void {
  const result = installPackagedLink(moduleUrl, parts, target);
  if (result === 'missing') throw new Error(`Packaged adapter is missing: ${parts.join('/')}`);
  if (result === 'occupied') throw new Error(`Refusing to replace non-Concord path: ${target}`);
}

export function installGlobalAdapters(
  moduleUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
): AdapterReport[] {
  const failures = new Map<HarnessName, string>();
  const attempt = (harness: HarnessName, action: () => void): void => {
    try {
      action();
    } catch (error) {
      failures.set(harness, error instanceof Error ? error.message : String(error));
    }
  };

  attempt('claude-code', () => {
    if (executablePath('claude', env) !== undefined) {
      requirePackagedLink(moduleUrl, ['plugin', 'concord-relay'], claudeSkillsPluginPath(env));
    }
  });

  const codex = executablePath('codex', env);
  attempt('codex', () => {
    if (codex !== undefined) {
      installCodexMcpConfig(env);
      installCodexHooks(env);
      const version = versionTuple(run(codex, ['--version'], env).output);
      if (version !== undefined && atLeast(version, HARNESS_CONFIGS.codex.minimumVersion)) {
        run(codex, ['app-server', 'daemon', 'bootstrap'], env);
        run(codex, ['app-server', 'daemon', 'start'], env);
        run(codex, ['app-server', 'daemon', 'enable-remote-control'], env);
      }
    }
  });

  attempt('gemini', () => {
    if (executablePath('gemini', env) !== undefined) {
      requirePackagedLink(moduleUrl, ['plugin', 'gemini', 'concord-relay'], geminiTarget(env));
    }
  });
  attempt('cursor', () => {
    if (executablePath('cursor', env) !== undefined) {
      requirePackagedLink(moduleUrl, ['plugin', 'cursor', 'concord-relay'], cursorTarget(env));
      installCursorHooks(env);
    }
  });
  const grok = executablePath('grok', env);
  attempt('grok', () => {
    if (grok !== undefined) {
      const source = packagedPath(moduleUrl, ['plugin', 'grok', 'concord-relay']);
      if (source === undefined) throw new Error('Packaged Grok adapter is missing.');
      const current = run(grok, ['plugin', 'list', '--json'], env);
      if (!current.output.includes('concord-relay')) {
        const installed = run(grok, ['plugin', 'install', source, '--trust'], env);
        if (!installed.ok) throw new Error(installed.output || 'Grok plugin installation failed.');
      }
    }
  });

  const report = statusGlobalAdapters(env, repoRoot).map((entry) => {
    const failure = failures.get(entry.harness);
    return failure === undefined
      ? entry
      : { ...entry, status: 'error' as const, detail: `Installation failed: ${failure}` };
  });
  const statePath = join(userHome(env), '.concord', 'adapters.json');
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ version: 1, adapters: report }, null, 2)}\n`, {
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(statePath, 0o600);
  } catch {
    // Adapter installation has already completed independently. Metadata is
    // diagnostic only and must not roll back working harnesses.
  }
  return report;
}

function removeOwnedLink(path: string): boolean {
  if (!isSymlink(path)) return false;
  if (!hasConcordManifest(path)) return false;
  rmSync(path);
  return true;
}

export function uninstallGlobalAdapters(env: NodeJS.ProcessEnv = process.env): AdapterReport[] {
  removeOwnedLink(claudeSkillsPluginPath(env));
  removeOwnedLink(geminiTarget(env));
  removeOwnedLink(cursorTarget(env));
  uninstallCursorHooks(env);
  const grok = executablePath('grok', env);
  if (grok !== undefined) run(grok, ['plugin', 'uninstall', 'concord-relay', '--confirm'], env);
  uninstallCodexConfig(env);
  const statePath = join(userHome(env), '.concord', 'adapters.json');
  if (existsSync(statePath)) rmSync(statePath);
  return statusGlobalAdapters(env);
}

export function renderAdapterReport(report: readonly AdapterReport[]): string {
  const lines = ['Harness adapters', ''];
  for (const entry of report) {
    const capability = entry.capabilities.length === 0 ? 'none' : entry.capabilities.join(', ');
    lines.push(
      `  ${entry.harness.padEnd(12)} ${entry.status.padEnd(19)} ${entry.monitor}`,
      `    capabilities: ${capability}`,
      `    ${entry.detail}`,
    );
  }
  return lines.join('\n');
}
