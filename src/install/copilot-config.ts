import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';

/** The key Concord registers itself under in a Copilot `mcpServers` map. */
export const CONCORD_COPILOT_SERVER_KEY = 'concord';
/** The binary Copilot spawns to run the stdio MCP server. */
export const CONCORD_SERVER_COMMAND = 'concord-mcp';

const looseObjectSchema = z.record(z.string(), z.unknown());

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

/**
 * Copilot CLI's user-scoped MCP config, under its config home. `COPILOT_HOME`
 * wins when set; otherwise the platform config directory (`~/.copilot` on
 * macOS/Linux, `%APPDATA%\\copilot` on Windows).
 */
export function copilotConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['COPILOT_HOME']?.trim();
  if (configured !== undefined && configured !== '') {
    return join(configured, 'mcp-config.json');
  }
  const appData = env['APPDATA']?.trim();
  if (appData !== undefined && appData !== '') {
    return join(appData, 'copilot', 'mcp-config.json');
  }
  return join(userHome(env), '.copilot', 'mcp-config.json');
}

function readConfig(path: string): UnknownRecord {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CopilotConfigParseError(path);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CopilotConfigParseError(path);
  }
  return looseObjectSchema.parse(parsed);
}

function writeConfig(path: string, config: UnknownRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

/** The Concord server entry Copilot should spawn, in Copilot's own shape. */
function concordServerEntry(repoRoot: string, kind: string): UnknownRecord {
  return {
    type: 'local',
    command: CONCORD_SERVER_COMMAND,
    args: [],
    env: { CONCORD_REPO_ROOT: repoRoot, CONCORD_AGENT_KIND: kind },
    tools: ['*'],
  };
}

/**
 * Idempotently add (or refresh) Concord's server entry in Copilot's
 * user-scoped MCP config. Every other server and every unrelated top-level
 * key is preserved, and passing the previous output back in is a no-op.
 * Returns the absolute config path.
 */
export function installCopilotMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
): string {
  const path = copilotConfigFile(env);
  const config = readConfig(path);
  const currentServers = config['mcpServers'];
  const parsedServers =
    currentServers === undefined
      ? { success: true as const, data: {} }
      : looseObjectSchema.safeParse(currentServers);
  if (!parsedServers.success) {
    throw new CopilotConfigParseError(path);
  }

  const servers: UnknownRecord = { ...parsedServers.data };
  const existingEntry = looseObjectSchema.safeParse(servers[CONCORD_COPILOT_SERVER_KEY]);
  const existingEnv =
    existingEntry.success && typeof existingEntry.data['env'] === 'object'
      ? looseObjectSchema.safeParse(existingEntry.data['env'])
      : { success: false as const };
  // Preserve a repo root already pinned by a previous setup when the caller
  // does not supply one (e.g. a plain re-run), and keep any unrelated env.
  const preservedRepoRoot =
    existingEnv.success && typeof existingEnv.data['CONCORD_REPO_ROOT'] === 'string'
      ? existingEnv.data['CONCORD_REPO_ROOT']
      : repoRoot;
  if (preservedRepoRoot === undefined) {
    throw new Error(
      'Concord needs a repository root to register with Copilot CLI. Run `concord setup` in a repository, or pass --repo.',
    );
  }

  servers[CONCORD_COPILOT_SERVER_KEY] = concordServerEntry(preservedRepoRoot, 'copilot-cli');
  writeConfig(path, { ...config, mcpServers: servers });
  return path;
}

/** Whether Concord's server is currently registered with Copilot CLI. */
export function copilotConfigInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = copilotConfigFile(env);
  if (!existsSync(path)) return false;
  try {
    const config = readConfig(path);
    const servers = looseObjectSchema.safeParse(config['mcpServers']);
    if (!servers.success) return false;
    const entry = looseObjectSchema.safeParse(servers.data[CONCORD_COPILOT_SERVER_KEY]);
    return entry.success && entry.data['command'] === CONCORD_SERVER_COMMAND;
  } catch {
    return false;
  }
}

/** Remove only Concord's own entry; every other server and key is preserved. */
export function uninstallCopilotConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = copilotConfigFile(env);
  if (!existsSync(path)) return;
  const config = readConfig(path);
  const servers = looseObjectSchema.safeParse(config['mcpServers']);
  if (!servers.success) return;
  if (!(CONCORD_COPILOT_SERVER_KEY in servers.data)) return;

  const next: UnknownRecord = {};
  for (const [key, value] of Object.entries(servers.data)) {
    if (key === CONCORD_COPILOT_SERVER_KEY) continue;
    next[key] = value;
  }
  writeConfig(path, { ...config, mcpServers: next });
}
