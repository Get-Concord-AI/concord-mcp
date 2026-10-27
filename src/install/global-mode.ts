import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userHome } from '../config/paths.js';
import { devinCliSupportsDedicatedMcpConfig, executablePath, run } from './adapters/index.js';
import { removeBlock, upsertBlock } from './block.js';
import { claudeConfigDir } from './claude-plugin.js';
import { codexHome } from './codex-config.js';
import { copilotHome } from './copilot-config.js';
import { gooseConfigPath } from './goose-config.js';
import {
  devinMcpConfigPath,
  hasDevinMcpServer,
  removeDevinMcpConfig,
  upsertDevinMcpConfig,
} from './devin-config.js';
import { removeDevinUserHooksConfig, upsertDevinUserHooksConfig } from './devin-user-hooks.js';
import { ANTIGRAVITY_RULE_HEADER, CONCORD_GLOBAL_INSTRUCTIONS } from './instructions.js';
import {
  CONCORD_SERVER_COMMAND,
  CONCORD_SERVER_KEY,
  hasGrokMcpServer,
  hasMcpServer,
  McpConfigParseError,
  removeGrokMcpServer,
  removeMcpServer,
  upsertGeminiSettings,
  upsertGrokMcpServer,
  upsertMcpServer,
} from './mcp-config.js';

/** What turning global mode on or off changed, and what it could not. */
export interface GlobalModeReport {
  written: string[];
  warnings: string[];
  registrations: string[];
}

/** A user-level MCP registration; `present` says whether a file already has one, anyone's. */
interface Registration {
  readonly id: string;
  readonly present: (existing: string) => boolean;
}

/** A user-level file global mode owns part of, for one harness. */
interface UserFile {
  /** If provided, this harness command must be installed unless isDetected is provided. */
  readonly executable?: string | undefined;
  /** Custom detection function for harnesses that can be detected without CLI on PATH. */
  readonly isDetected?: ((env: NodeJS.ProcessEnv) => boolean) | undefined;
  /** Set for an MCP registration, which `--no-mcp` skips. */
  readonly registration?: Registration | undefined;
  /** Optional harness version gate for a registration format. */
  readonly supported?: ((env: NodeJS.ProcessEnv) => boolean) | undefined;
  readonly path: (env: NodeJS.ProcessEnv) => string;
  readonly install: (existing: string | undefined, path: string) => string;
  readonly uninstall: (existing: string) => string;
}

/** Grok's user directory: `GROK_HOME`, or `~/.grok`. */
function grokHome(env: NodeJS.ProcessEnv): string {
  const configured = env['GROK_HOME']?.trim();
  return configured === undefined || configured === '' ? join(userHome(env), '.grok') : configured;
}

function antigravityConfigDir(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.gemini', 'config');
}

function isAntigravityDetected(env: NodeJS.ProcessEnv): boolean {
  return (
    executablePath('agy', env) !== undefined ||
    env['ANTIGRAVITY_AGENT'] === '1' ||
    existsSync(antigravityConfigDir(env))
  );
}

function instructionFile(
  executable: string,
  path: (env: NodeJS.ProcessEnv) => string,
  header?: string,
  isDetected?: (env: NodeJS.ProcessEnv) => boolean,
): UserFile {
  return {
    executable,
    ...(isDetected !== undefined ? { isDetected } : {}),
    path,
    install: (existing) => upsertBlock(existing ?? header ?? '', CONCORD_GLOBAL_INSTRUCTIONS),
    uninstall: (existing) => {
      const rest = removeBlock(existing);
      if (rest.trim() === header?.trim()) {
        return '';
      }
      return rest;
    },
  };
}

/**
 * User-level instructions, and MCP registrations edited directly (Codex,
 * Goose, and Copilot CLI adapters register themselves). Cursor's instructions come from its
 * sessionStart hook, as its user rules are not a file.
 */
const USER_FILES: readonly UserFile[] = [
  instructionFile('claude', (env) => join(claudeConfigDir(env), 'CLAUDE.md')),
  instructionFile('codex', (env) => join(codexHome(env), 'AGENTS.md')),
  instructionFile('gemini', (env) => join(userHome(env), '.gemini', 'GEMINI.md')),
  instructionFile('goose', (env) => join(dirname(gooseConfigPath(env)), '.goosehints')),
  instructionFile('copilot', (env) => join(copilotHome(env), 'copilot-instructions.md')),
  instructionFile(
    'agy',
    (env) => join(antigravityConfigDir(env), 'rules', 'concord.md'),
    ANTIGRAVITY_RULE_HEADER,
    isAntigravityDetected,
  ),
  instructionFile('devin', (env) => join(dirname(devinMcpConfigPath(env)), 'AGENTS.md')),
  {
    executable: 'devin',
    path: (env) => join(dirname(devinMcpConfigPath(env)), 'config.json'),
    install: (existing) => upsertDevinUserHooksConfig(existing),
    uninstall: removeDevinUserHooksConfig,
  },
  {
    executable: 'devin',
    registration: { id: 'devin', present: hasDevinMcpServer },
    supported: devinCliSupportsDedicatedMcpConfig,
    path: devinMcpConfigPath,
    install: (existing) => upsertDevinMcpConfig(existing),
    uninstall: removeDevinMcpConfig,
  },
  {
    executable: 'gemini',
    registration: { id: 'gemini', present: hasMcpServer },
    path: (env) => join(userHome(env), '.gemini', 'settings.json'),
    install: (existing) => upsertGeminiSettings(existing, undefined),
    // Only the server goes: the shell settings may serve other tools by now.
    uninstall: removeMcpServer,
  },
  {
    executable: 'cursor',
    registration: { id: 'cursor', present: hasMcpServer },
    path: (env) => join(userHome(env), '.cursor', 'mcp.json'),
    install: (existing) => upsertMcpServer(existing, undefined),
    uninstall: removeMcpServer,
  },
  {
    executable: 'grok',
    registration: { id: 'grok', present: hasGrokMcpServer },
    path: (env) => join(grokHome(env), 'config.toml'),
    install: (existing, path) => upsertGrokMcpServer(existing, undefined, path),
    uninstall: (existing) => {
      const rest = removeGrokMcpServer(existing);
      return rest === '' ? '' : `${rest}\n`;
    },
  },
  {
    executable: 'agy',
    isDetected: isAntigravityDetected,
    registration: { id: 'antigravity', present: hasMcpServer },
    path: (env) => join(antigravityConfigDir(env), 'mcp_config.json'),
    install: (existing) =>
      upsertMcpServer(existing, undefined, { CONCORD_AGENT_KIND: 'antigravity' }),
    uninstall: removeMcpServer,
  },
];

/** A registration global mode added, or a missing one, may change; the user's own never does. */
function mayChange(
  registration: Registration,
  enable: boolean,
  existing: string | undefined,
  owned: ReadonlySet<string>,
): boolean {
  if (owned.has(registration.id)) return true;
  return enable && (existing === undefined || !registration.present(existing));
}

function isFileDetected(file: UserFile, env: NodeJS.ProcessEnv): boolean {
  if (file.isDetected !== undefined) return file.isDetected(env);
  if (file.executable !== undefined) return executablePath(file.executable, env) !== undefined;
  return false;
}

function applyFile(
  env: NodeJS.ProcessEnv,
  file: UserFile,
  enable: boolean,
  owned: Set<string>,
  report: GlobalModeReport,
): void {
  const path = file.path(env);
  const exists = existsSync(path);
  if (enable ? !isFileDetected(file, env) : !exists) return;
  if (enable && file.supported !== undefined && !file.supported(env)) return;
  try {
    const existing = exists ? readFileSync(path, 'utf8') : undefined;
    const { registration } = file;
    if (registration !== undefined && !mayChange(registration, enable, existing, owned)) return;
    const next = enable ? file.install(existing, path) : file.uninstall(existing ?? '');
    if (next !== existing) {
      if (next === '') {
        rmSync(path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, next);
      }
      report.written.push(path);
    }
    if (registration !== undefined) {
      if (enable) owned.add(registration.id);
      else owned.delete(registration.id);
    }
  } catch (error) {
    // A parse error already names the file it could not change.
    report.warnings.push(
      error instanceof McpConfigParseError
        ? error.message
        : `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Claude Code's user-scope registration, through its CLI; an existing one is the user's unless owned. */
function applyClaude(
  env: NodeJS.ProcessEnv,
  enable: boolean,
  owned: Set<string>,
  report: GlobalModeReport,
): void {
  const claude = executablePath('claude', env);
  if (claude === undefined || (!enable && !owned.has('claude'))) return;
  const args = enable
    ? ['mcp', 'add', '--scope', 'user', CONCORD_SERVER_KEY, CONCORD_SERVER_COMMAND]
    : ['mcp', 'remove', '--scope', 'user', CONCORD_SERVER_KEY];
  const result = run(claude, args, env);
  if (result.ok) {
    report.written.push(`claude ${args.join(' ')}`);
    if (enable) owned.add('claude');
    else owned.delete('claude');
  } else if (!enable && /no mcp server named/iu.test(result.output)) {
    owned.delete('claude');
  } else if (!(enable && /already exists/iu.test(result.output))) {
    report.warnings.push(`claude ${args.join(' ')}: ${result.output || 'failed'}`);
  }
}

/**
 * Turn global mode on or off for each installed harness: user-level MCP
 * registration and instructions. Only `registrations` it added are ever
 * changed or removed; each harness's failure is reported, not thrown.
 */
export function applyGlobalMode(
  env: NodeJS.ProcessEnv,
  enable: boolean,
  options: { mcp?: boolean; registrations?: readonly string[] } = {},
): GlobalModeReport {
  const owned = new Set(options.registrations);
  const report: GlobalModeReport = { written: [], warnings: [], registrations: [] };
  const mcp = options.mcp !== false;
  for (const file of USER_FILES) {
    if (mcp || file.registration === undefined) applyFile(env, file, enable, owned, report);
  }
  if (mcp) applyClaude(env, enable, owned, report);
  report.registrations = [...owned].sort();
  return report;
}
