import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userHome } from '../config/paths.js';
import { executablePath, run } from './adapters/index.js';
import { removeBlock, upsertBlock } from './block.js';
import { claudeConfigDir } from './claude-plugin.js';
import { codexHome } from './codex-config.js';
import { gooseConfigPath } from './goose-config.js';
import { CONCORD_GLOBAL_INSTRUCTIONS } from './instructions.js';
import {
  CONCORD_SERVER_COMMAND,
  CONCORD_SERVER_KEY,
  hasGrokMcpServer,
  hasMcpServer,
  removeGrokMcpServer,
  removeMcpServer,
  upsertGeminiSettings,
  upsertGrokMcpServer,
} from './mcp-config.js';

/** What turning global mode on or off changed, and what it could not. */
export interface GlobalModeReport {
  written: string[];
  warnings: string[];
  /** The user-level registrations global mode now owns, to remember for turning it off. */
  registrations: string[];
}

/** A user-level MCP registration global mode may add, and so later remove. */
interface Registration {
  readonly id: string;
  /** Whether the file already registers Concord, by global mode or by the user. */
  readonly present: (existing: string) => boolean;
}

/** A user-level file global mode owns part of, for one harness. */
interface UserFile {
  /** The harness's command: nothing is written for a harness that is not installed. */
  readonly executable: string;
  /** Set for an MCP registration, which `--no-mcp` leaves to the user. */
  readonly registration?: Registration;
  readonly path: (env: NodeJS.ProcessEnv) => string;
  readonly install: (existing: string | undefined) => string;
  readonly uninstall: (existing: string) => string;
}

/** Grok's user directory: `GROK_HOME`, or `~/.grok`. */
function grokHome(env: NodeJS.ProcessEnv): string {
  const configured = env['GROK_HOME']?.trim();
  return configured === undefined || configured === '' ? join(userHome(env), '.grok') : configured;
}

function instructionFile(executable: string, path: (env: NodeJS.ProcessEnv) => string): UserFile {
  return {
    executable,
    path,
    install: (existing) => upsertBlock(existing ?? '', CONCORD_GLOBAL_INSTRUCTIONS),
    uninstall: removeBlock,
  };
}

/**
 * Each harness's user-level instructions, and the MCP registration for the
 * harnesses whose user config Concord edits directly. Codex and Goose are
 * registered machine-wide by their adapters already; Claude Code through its
 * own CLI, below. Cursor's user rules are not a file, so it is not here.
 */
const USER_FILES: readonly UserFile[] = [
  instructionFile('claude', (env) => join(claudeConfigDir(env), 'CLAUDE.md')),
  instructionFile('codex', (env) => join(codexHome(env), 'AGENTS.md')),
  instructionFile('gemini', (env) => join(userHome(env), '.gemini', 'GEMINI.md')),
  instructionFile('goose', (env) => join(dirname(gooseConfigPath(env)), '.goosehints')),
  {
    executable: 'gemini',
    registration: { id: 'gemini', present: hasMcpServer },
    path: (env) => join(userHome(env), '.gemini', 'settings.json'),
    install: (existing) => upsertGeminiSettings(existing),
    // Only the server goes: the shell settings may serve other tools by now.
    uninstall: removeMcpServer,
  },
  {
    executable: 'grok',
    registration: { id: 'grok', present: hasGrokMcpServer },
    path: (env) => join(grokHome(env), 'config.toml'),
    install: (existing) => upsertGrokMcpServer(existing),
    uninstall: (existing) => {
      const rest = removeGrokMcpServer(existing);
      return rest === '' ? '' : `${rest}\n`;
    },
  },
];

/**
 * Whether global mode may change this file's registration: one it added, or
 * none yet. A registration the user made themselves is never touched.
 */
function mayChange(
  registration: Registration,
  enable: boolean,
  existing: string | undefined,
  owned: ReadonlySet<string>,
): boolean {
  if (owned.has(registration.id)) return true;
  return enable && (existing === undefined || !registration.present(existing));
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
  if (enable ? executablePath(file.executable, env) === undefined : !exists) return;
  try {
    const existing = exists ? readFileSync(path, 'utf8') : undefined;
    const { registration } = file;
    if (registration !== undefined && !mayChange(registration, enable, existing, owned)) return;
    const next = enable ? file.install(existing) : file.uninstall(existing ?? '');
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
    report.warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Register Concord at Claude Code's user scope, through its own CLI. A server
 * the CLI says already exists is the user's own unless global mode added it.
 */
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
 * Turn global mode on or off for every installed harness: user-level MCP
 * registration plus a short instruction block, so agents use Concord in
 * repositories where `concord setup` was never run. Only registrations it
 * added (`registrations`, from the last run) are ever changed or removed.
 * Each harness succeeds or fails on its own; failures are reported.
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
