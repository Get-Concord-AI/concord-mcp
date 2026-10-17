import { spawnSync } from 'node:child_process';
import { existsSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import {
  HARNESS_CONFIGS,
  type HarnessName,
  type MonitorKind,
} from '../../domain/harness-config.js';
import { userHome } from '../../config/paths.js';
import { installCodexHooks, installCodexMcpConfig, uninstallCodexConfig } from '../codex-config.js';
import {
  gooseConfigInstalled,
  installGooseMcpConfig,
  uninstallGooseConfig,
} from '../goose-config.js';
import {
  hasMcpServer,
  isConcordServerOwned,
  removeMcpServer,
  upsertMcpServer,
} from '../mcp-config.js';
import {
  cursorTarget,
  hasConcordManifest,
  inspectLink,
  installLink,
  isEphemeralPath,
  isSymlink,
  linkNeedsRepair,
  linkTarget,
  packagedAdapter,
  packagedPath,
  type EphemeralTest,
  type LinkCheck,
  type LinkedHarness,
} from './links.js';

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
  /** Present when the adapter link points somewhere other than this package. */
  link?: LinkCheck | undefined;
}

export function executablePath(name: string, env: NodeJS.ProcessEnv): string | undefined {
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

export function run(
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

/** The running package, and which paths count as throwaway checkouts. */
interface LinkContext {
  moduleUrl: string;
  isEphemeral: EphemeralTest;
}

function linkCheck(harness: LinkedHarness, env: NodeJS.ProcessEnv, links: LinkContext): LinkCheck {
  return inspectLink(linkTarget(harness, env), packagedAdapter(links.moduleUrl, harness));
}

/** A link that is broken, reported with where it points and how to fix it. */
function brokenLinkReport(
  harness: LinkedHarness,
  detected: boolean,
  monitor: MonitorKind,
  link: LinkCheck,
  isEphemeral: EphemeralTest,
): AdapterReport | undefined {
  if (!linkNeedsRepair(link, isEphemeral)) return undefined;
  const problem =
    link.health === 'dangling'
      ? 'which no longer exists'
      : 'a temporary checkout that will be cleaned up';
  const fix =
    link.expected === undefined
      ? 'Run `concord setup` from the installed package'
      : `Run \`concord doctor --fix\` to link it to ${link.expected}`;
  return {
    harness,
    detected,
    status: 'action_required',
    monitor,
    capabilities: [],
    detail: `${link.target} links to ${link.pointsTo ?? 'nothing'}, ${problem}. ${fix}.`,
    link,
  };
}

function installedLinkReport(
  harness: LinkedHarness,
  detected: boolean,
  monitor: MonitorKind,
  link: LinkCheck,
  capabilities: string[],
  detail: string,
): AdapterReport {
  const installed = link.health === 'linked' || link.health === 'foreign';
  return {
    harness,
    detected,
    status: installed ? 'installed' : detected ? 'action_required' : 'not_detected',
    monitor,
    capabilities,
    ...foreignLinkNote(link, detail),
    ...(installed ? { installedPath: link.target } : {}),
  };
}

/** A working link to another Concord copy keeps its paths visible in the report. */
function foreignLinkNote(link: LinkCheck, detail: string): Pick<AdapterReport, 'detail' | 'link'> {
  if (link.health !== 'foreign') return { detail };
  return {
    detail: `${detail} Linked to the Concord copy at ${link.pointsTo ?? link.target}, not this one.`,
    link,
  };
}

function statusClaude(env: NodeJS.ProcessEnv, links: LinkContext): AdapterReport {
  const config = HARNESS_CONFIGS['claude-code'];
  const executable = executablePath(config.executable, env);
  const link = linkCheck('claude-code', env, links);
  const broken = brokenLinkReport(
    'claude-code',
    executable !== undefined,
    config.monitor.kind,
    link,
    links.isEphemeral,
  );
  if (broken !== undefined) return broken;
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
    'claude-code',
    executable !== undefined,
    config.monitor.kind,
    link,
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

function statusGemini(
  env: NodeJS.ProcessEnv,
  links: LinkContext,
  repoRoot?: string,
): AdapterReport {
  const config = HARNESS_CONFIGS.gemini;
  const executable = executablePath(config.executable, env);
  const link = linkCheck('gemini', env, links);
  const detected = executable !== undefined;
  const broken = brokenLinkReport('gemini', detected, config.monitor.kind, link, links.isEphemeral);
  if (broken !== undefined) return broken;
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
    'gemini',
    executable !== undefined,
    config.monitor.kind,
    link,
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

function statusCursor(env: NodeJS.ProcessEnv, links: LinkContext): AdapterReport {
  const config = HARNESS_CONFIGS.cursor;
  const target = cursorTarget(env);
  const executable = executablePath(config.executable, env);
  const detected = executable !== undefined;
  const link = linkCheck('cursor', env, links);
  const broken = brokenLinkReport('cursor', detected, config.monitor.kind, link, links.isEphemeral);
  if (broken !== undefined) return broken;
  const extensionInstalled = link.health === 'linked' || link.health === 'foreign';
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
    ...foreignLinkNote(
      link,
      installed
        ? config.installedDetail
        : 'The Cursor extension and global lifecycle hooks are not both installed.',
    ),
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

function statusGoose(env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS.goose;
  const executable = executablePath(config.executable, env);
  if (executable === undefined) {
    return {
      harness: config.name,
      detected: false,
      status: 'not_detected',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: 'Goose CLI was not found on PATH.',
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
  const installed = gooseConfigInstalled(env);
  return {
    harness: config.name,
    detected: true,
    status: installed ? 'installed' : 'action_required',
    monitor: config.monitor.kind,
    capabilities: installed ? [...config.installedCapabilities] : ['pull', 'busy'],
    detail: installed
      ? config.installedDetail
      : 'Concord MCP server is not yet registered with Goose.',
  };
}

function statusAntigravity(env: NodeJS.ProcessEnv, repoRoot?: string): AdapterReport {
  const config = HARNESS_CONFIGS.antigravity;
  const executable = executablePath(config.executable, env);
  const detected =
    executable !== undefined ||
    env['ANTIGRAVITY_AGENT'] === '1' ||
    existsSync(join(userHome(env), '.gemini', 'config'));

  if (!detected) {
    return {
      harness: config.name,
      detected: false,
      status: 'not_detected',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: 'Antigravity is not installed or not detected in environment.',
    };
  }

  const workspaceMcpPath =
    repoRoot === undefined ? undefined : join(repoRoot, '.agents', 'mcp_config.json');
  const globalMcpPath = join(userHome(env), '.gemini', 'config', 'mcp_config.json');
  let hasWorkspace = false;
  let hasGlobal = false;
  try {
    if (workspaceMcpPath !== undefined && existsSync(workspaceMcpPath)) {
      hasWorkspace = hasMcpServer(readFileSync(workspaceMcpPath, 'utf8'));
    }
    if (existsSync(globalMcpPath)) {
      hasGlobal = hasMcpServer(readFileSync(globalMcpPath, 'utf8'));
    }
  } catch (error) {
    return {
      harness: config.name,
      detected: true,
      status: 'error',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: `Failed to read Antigravity configuration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const installed = hasWorkspace || hasGlobal;

  return {
    harness: config.name,
    detected: true,
    status: installed ? 'installed' : 'action_required',
    monitor: config.monitor.kind,
    capabilities: installed ? [...config.installedCapabilities] : ['pull', 'busy'],
    detail: installed
      ? config.installedDetail
      : 'Concord MCP server is not yet registered in .agents/mcp_config.json or ~/.gemini/config/mcp_config.json.',
  };
}

export function statusGlobalAdapters(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
  moduleUrl: string = import.meta.url,
  isEphemeral: EphemeralTest = isEphemeralPath,
): AdapterReport[] {
  const links = { moduleUrl, isEphemeral };
  return [
    statusClaude(env, links),
    statusCodex(env),
    statusCursor(env, links),
    statusGemini(env, links, repoRoot),
    statusGrok(env),
    statusGoose(env),
    statusAntigravity(env, repoRoot),
  ];
}

function requirePackagedLink(
  moduleUrl: string,
  harness: LinkedHarness,
  env: NodeJS.ProcessEnv,
  isEphemeral: EphemeralTest,
): void {
  const source = packagedAdapter(moduleUrl, harness);
  const target = linkTarget(harness, env);
  if (source === undefined) throw new Error(`Packaged ${harness} adapter is missing.`);
  if (installLink(source, target, isEphemeral) === 'occupied') {
    throw new Error(`Refusing to replace non-Concord path: ${target}`);
  }
}

export function installGlobalAdapters(
  moduleUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
  isEphemeral: EphemeralTest = isEphemeralPath,
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
      requirePackagedLink(moduleUrl, 'claude-code', env, isEphemeral);
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
      requirePackagedLink(moduleUrl, 'gemini', env, isEphemeral);
    }
  });
  attempt('cursor', () => {
    if (executablePath('cursor', env) !== undefined) {
      requirePackagedLink(moduleUrl, 'cursor', env, isEphemeral);
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

  attempt('goose', () => {
    const goose = executablePath('goose', env);
    if (goose === undefined) return;
    const version = versionTuple(run(goose, ['--version'], env).output);
    if (version === undefined || !atLeast(version, HARNESS_CONFIGS.goose.minimumVersion)) {
      return;
    }
    installGooseMcpConfig(env);
  });

  attempt('antigravity', () => {
    const config = HARNESS_CONFIGS.antigravity;
    const executable = executablePath(config.executable, env);
    const detected =
      executable !== undefined ||
      env['ANTIGRAVITY_AGENT'] === '1' ||
      existsSync(join(userHome(env), '.gemini', 'config'));
    if (!detected) return;
    const path = join(userHome(env), '.gemini', 'config', 'mcp_config.json');
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8');
      if (hasMcpServer(existing)) {
        // A concord server entry is already registered (custom or standard) — preserve it!
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, upsertMcpServer(existing));
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, upsertMcpServer(undefined));
    }
  });

  const report = statusGlobalAdapters(env, repoRoot, moduleUrl, isEphemeral).map((entry) => {
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
  // A dangling link has no manifest left to check, and is never anyone's work.
  if (existsSync(path) && !hasConcordManifest(path)) return false;
  rmSync(path);
  return true;
}

export function uninstallGlobalAdapters(env: NodeJS.ProcessEnv = process.env): AdapterReport[] {
  removeOwnedLink(linkTarget('claude-code', env));
  removeOwnedLink(linkTarget('gemini', env));
  removeOwnedLink(linkTarget('cursor', env));
  uninstallCursorHooks(env);
  const grok = executablePath('grok', env);
  if (grok !== undefined) run(grok, ['plugin', 'uninstall', 'concord-relay', '--confirm'], env);
  uninstallCodexConfig(env);
  uninstallGooseConfig(env);
  const antigravityMcp = join(userHome(env), '.gemini', 'config', 'mcp_config.json');
  if (existsSync(antigravityMcp)) {
    try {
      const existing = readFileSync(antigravityMcp, 'utf8');
      if (hasMcpServer(existing) && isConcordServerOwned(existing)) {
        writeFileSync(antigravityMcp, removeMcpServer(existing));
      }
    } catch {
      // Unreadable or malformed config is left untouched.
    }
  }
  const statePath = join(userHome(env), '.concord', 'adapters.json');
  if (existsSync(statePath)) rmSync(statePath);
  return statusGlobalAdapters(env);
}

/** A harness that is set up but not working, or whose adapter link is broken. */
export function adapterNeedsAttention(entry: AdapterReport): boolean {
  if (entry.status === 'error') return true;
  return entry.status === 'action_required' && (entry.detected || entry.link !== undefined);
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
    if (entry.link !== undefined) {
      lines.push(
        `    link:     ${entry.link.target} -> ${entry.link.pointsTo ?? '(none)'}`,
        `    expected: ${entry.link.expected ?? '(no packaged adapter in this copy)'}`,
      );
    }
  }
  return lines.join('\n');
}
