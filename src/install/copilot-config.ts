import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';
import { CONCORD_SERVER_COMMAND, CONCORD_SERVER_KEY } from './mcp-config.js';

/**
 * Copilot CLI's user-level registration: one MCP server entry and one hooks
 * file, both under the Copilot config home.
 *
 * The server entry pins only the harness kind. Copilot starts MCP servers in
 * the project directory and hands them `COPILOT_AGENT_SESSION_ID`, so the
 * server finds both the repository and the session itself — a pinned
 * `CONCORD_REPO_ROOT` here would send every repository's work to whichever one
 * ran setup first.
 */

const COPILOT_KIND = 'copilot-cli';
const HOOKS_FILE = 'concord.json';

const looseObjectSchema = z.record(z.string(), z.unknown());
const stringRecordSchema = z.record(z.string(), z.string());
const hooksFileSchema = z
  .object({ hooks: z.record(z.string(), z.array(z.object({ bash: z.string() }).loose())) })
  .loose();

type UnknownRecord = z.infer<typeof looseObjectSchema>;

/**
 * Thrown when the existing Copilot MCP config cannot be parsed. The caller
 * reports this and leaves the file untouched rather than overwriting
 * hand-written config.
 */
export class CopilotConfigParseError extends Error {
  constructor(readonly filePath: string) {
    super(`${filePath} is not valid JSON — fix or remove it, then re-run.`);
    this.name = 'CopilotConfigParseError';
  }
}

/** Copilot CLI's config home: `COPILOT_HOME` when set, else `~/.copilot`. */
export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['COPILOT_HOME']?.trim();
  return configured !== undefined && configured !== ''
    ? configured
    : join(userHome(env), '.copilot');
}

/** Copilot CLI's user-scoped MCP config. */
export function copilotConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(copilotHome(env), 'mcp-config.json');
}

/** The hooks file Concord owns outright in Copilot's user hooks directory. */
export function copilotHooksFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(copilotHome(env), 'hooks', HOOKS_FILE);
}

function hookEntry(event: string, timeoutSec: number) {
  const command = `concord hook ${event} --client ${COPILOT_KIND}`;
  return { type: 'command', bash: command, powershell: command, timeoutSec } as const;
}

/**
 * Session start registers the session and tells it who it is; post-tool-use
 * delivers messages mid-turn; agent-stop keeps the turn going when a message
 * arrived after the last tool call. Copilot's prompt-submitted hook cannot add
 * context, so it is not used.
 */
export const COPILOT_HOOKS = {
  version: 1,
  hooks: {
    sessionStart: [hookEntry('session-start', 10)],
    postToolUse: [hookEntry('post-tool-use', 5)],
    agentStop: [hookEntry('stop', 5)],
  },
} as const;

function readConfig(path: string): UnknownRecord {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CopilotConfigParseError(path);
  }
  const parsed = looseObjectSchema.safeParse(raw);
  if (!parsed.success) throw new CopilotConfigParseError(path);
  return parsed.data;
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function serversOf(config: UnknownRecord, path: string): UnknownRecord {
  if (config['mcpServers'] === undefined) return {};
  const servers = looseObjectSchema.safeParse(config['mcpServers']);
  if (!servers.success) throw new CopilotConfigParseError(path);
  return servers.data;
}

/**
 * Env to keep from an existing entry: whatever the user added (such as
 * `CONCORD_AGENT_ID`), minus a repository pin an older setup wrote.
 */
function preservedEnv(entry: UnknownRecord[string]): Record<string, string> {
  const parsed = looseObjectSchema.safeParse(entry);
  const env = parsed.success ? stringRecordSchema.safeParse(parsed.data['env']) : undefined;
  if (env?.success !== true) return {};
  return Object.fromEntries(
    Object.entries(env.data).filter(([key]) => key !== 'CONCORD_REPO_ROOT'),
  );
}

/**
 * Idempotently add (or refresh) Concord's entry in Copilot's user-scoped MCP
 * config. Every other server, every unrelated top-level key, and env the user
 * added to the entry is preserved. Returns the absolute config path.
 */
export function installCopilotMcpConfig(env: NodeJS.ProcessEnv = process.env): string {
  const path = copilotConfigFile(env);
  const config = readConfig(path);
  const servers = serversOf(config, path);
  const entry = {
    type: 'local',
    command: CONCORD_SERVER_COMMAND,
    args: [],
    env: { ...preservedEnv(servers[CONCORD_SERVER_KEY]), CONCORD_AGENT_KIND: COPILOT_KIND },
    tools: ['*'],
  };
  const next = { ...config, mcpServers: { ...servers, [CONCORD_SERVER_KEY]: entry } };
  writePrivate(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

/** Write Concord's lifecycle hooks file. Returns the absolute path. */
export function installCopilotHooks(env: NodeJS.ProcessEnv = process.env): string {
  const path = copilotHooksFile(env);
  writePrivate(path, `${JSON.stringify(COPILOT_HOOKS, null, 2)}\n`);
  return path;
}

/** Whether Concord's server is registered with Copilot CLI. */
export function copilotConfigInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const path = copilotConfigFile(env);
    const entry = looseObjectSchema.safeParse(
      serversOf(readConfig(path), path)[CONCORD_SERVER_KEY],
    );
    return entry.success && entry.data['command'] === CONCORD_SERVER_COMMAND;
  } catch {
    return false;
  }
}

/** Whether Concord's hooks file is present and still runs every Concord hook. */
export function copilotHooksInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = copilotHooksFile(env);
  if (!existsSync(path)) return false;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = hooksFileSchema.safeParse(raw);
    if (!parsed.success) return false;
    const { hooks } = parsed.data;
    return Object.entries(COPILOT_HOOKS.hooks).every(([event, [expected]]) =>
      (hooks[event] ?? []).some((entry) => entry.bash === expected.bash),
    );
  } catch {
    return false;
  }
}

/**
 * Remove Concord's server entry and hooks file. Every other server and key is
 * preserved; a config that cannot be parsed is left untouched.
 */
export function uninstallCopilotConfig(env: NodeJS.ProcessEnv = process.env): void {
  const hooksPath = copilotHooksFile(env);
  if (existsSync(hooksPath)) rmSync(hooksPath);

  const path = copilotConfigFile(env);
  let config: UnknownRecord;
  let servers: UnknownRecord;
  try {
    config = readConfig(path);
    servers = serversOf(config, path);
  } catch {
    return;
  }
  if (!(CONCORD_SERVER_KEY in servers)) return;
  const remaining = Object.fromEntries(
    Object.entries(servers).filter(([key]) => key !== CONCORD_SERVER_KEY),
  );
  writePrivate(path, `${JSON.stringify({ ...config, mcpServers: remaining }, null, 2)}\n`);
}
