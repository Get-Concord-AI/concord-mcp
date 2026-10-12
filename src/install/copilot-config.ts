import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';

/** The key Concord registers itself under in a Copilot `mcpServers` map. */
export const CONCORD_COPILOT_SERVER_KEY = 'concord';
/** The binary Copilot spawns to run the stdio MCP server. */
export const CONCORD_SERVER_COMMAND = 'concord-mcp';
/** The client kind Concord pins into its own MCP registration. */
const CONCORD_AGENT_KIND = 'copilot-cli';

/**
 * A JSON value Concord preserves verbatim without interpreting. This is a
 * concrete recursive type, not `unknown`: every preserved value is narrowed
 * here at the parse boundary and only ever serialised back to disk.
 */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), jsonArraySchema, jsonObjectSchema]),
);

const jsonArraySchema: z.ZodType<readonly JsonValue[]> = z.lazy(() => z.array(jsonValueSchema));

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

/** The exact shape Concord writes for its own server entry. */
const concordServerSchema = z.object({
  type: z.literal('local'),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  tools: z.array(z.string()),
});

type ConcordServerEntry = z.infer<typeof concordServerSchema>;

const stringRecordSchema = z.record(z.string(), z.string());
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
 * macOS/Linux, `%APPDATA%\copilot` on Windows).
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

function readConfig(path: string): JsonObject {
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
  return jsonObjectSchema.parse(parsed);
}

function writeConfig(path: string, config: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

/** The server entry object Concord serialises into the config. */
function concordServerEntryObject(repoRoot: string): ConcordServerEntry {
  return concordServerSchema.parse({
    type: 'local',
    command: CONCORD_SERVER_COMMAND,
    args: [],
    env: { CONCORD_REPO_ROOT: repoRoot, CONCORD_AGENT_KIND },
    tools: ['*'],
  });
}

/** The `mcpServers` object, or `undefined` when it is absent or not an object. */
function readServers(config: JsonObject, path: string): JsonObject | undefined {
  const servers = config['mcpServers'];
  if (servers === undefined) return undefined;
  const parsed = jsonObjectSchema.safeParse(servers);
  if (!parsed.success) throw new CopilotConfigParseError(path);
  return parsed.data;
}

/** The env object of an existing entry, narrowed to strings, when present. */
function readEntryEnv(entry: JsonValue | undefined): Record<string, string> | undefined {
  if (entry === undefined) return undefined;
  const entryObject = jsonObjectSchema.safeParse(entry);
  if (!entryObject.success) return undefined;
  const env = entryObject.data['env'];
  if (env === undefined) return undefined;
  const parsed = stringRecordSchema.safeParse(env);
  return parsed.success ? parsed.data : undefined;
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
  const existingServers = readServers(config, path) ?? {};

  // Preserve a repo root already pinned by a previous setup when the caller
  // does not supply one (e.g. a plain re-run), keep any unrelated env the
  // user added (e.g. CONCORD_AGENT_ID), and only refresh the two managed keys.
  const existingEnv = readEntryEnv(existingServers[CONCORD_COPILOT_SERVER_KEY]);
  const pinnedRoot = existingEnv?.['CONCORD_REPO_ROOT'];
  const preservedRepoRoot = typeof pinnedRoot === 'string' ? pinnedRoot : repoRoot;
  if (preservedRepoRoot === undefined) {
    throw new Error(
      'Concord needs a repository root to register with Copilot CLI. Run `concord setup` in a repository, or pass --repo.',
    );
  }

  const entry = concordServerEntryObject(preservedRepoRoot);
  const mergedEnv: Record<string, string> = {
    ...existingEnv,
    ...entry.env,
  };
  const servers: JsonObject = {
    ...existingServers,
    [CONCORD_COPILOT_SERVER_KEY]: { ...entry, env: mergedEnv },
  };
  writeConfig(path, { ...config, mcpServers: servers });
  return path;
}

/** Whether Concord's server is currently registered with Copilot CLI. */
export function copilotConfigInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = copilotConfigFile(env);
  if (!existsSync(path)) return false;
  try {
    const servers = readServers(readConfig(path), path);
    const entry = jsonObjectSchema.safeParse(servers?.[CONCORD_COPILOT_SERVER_KEY]);
    return entry.success && entry.data['command'] === CONCORD_SERVER_COMMAND;
  } catch {
    return false;
  }
}

/** Remove only Concord's own entry; every other server and key is preserved. */
export function uninstallCopilotConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = copilotConfigFile(env);
  if (!existsSync(path)) return;
  let config: JsonObject;
  try {
    config = readConfig(path);
  } catch {
    // A malformed config is left untouched rather than aborting the whole
    // adapter uninstall, which must finish cleaning up the other harnesses.
    return;
  }
  const servers = readServers(config, path);
  if (servers === undefined || !(CONCORD_COPILOT_SERVER_KEY in servers)) return;

  const next: JsonObject = {};
  for (const [key, value] of Object.entries(servers)) {
    if (key === CONCORD_COPILOT_SERVER_KEY) continue;
    next[key] = value;
  }
  writeConfig(path, { ...config, mcpServers: next });
}
