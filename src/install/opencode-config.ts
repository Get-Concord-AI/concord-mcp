import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/** The key Concord registers itself under in an OpenCode `mcp` map. */
export const CONCORD_OPENCODE_SERVER_KEY = 'concord';
/** The binary OpenCode spawns to run the stdio MCP server. */
export const CONCORD_SERVER_COMMAND = 'concord-mcp';
/** The client kind Concord pins into its own MCP registration. */
const CONCORD_AGENT_KIND = 'opencode';

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

const stringRecordSchema = z.record(z.string(), z.string());

/** The exact shape Concord writes for its own server entry. */
const concordServerSchema = z.object({
  type: z.literal('local'),
  command: z.array(z.string()),
  environment: z.record(z.string(), z.string()),
  enabled: z.literal(true),
});

type ConcordServerEntry = z.infer<typeof concordServerSchema>;

/**
 * Thrown when the existing OpenCode config cannot be parsed. The caller
 * reports this and leaves the file untouched rather than overwriting
 * hand-written config.
 */
export class OpenCodeConfigParseError extends Error {
  constructor(readonly filePath: string) {
    super(`${filePath} is not valid JSON — fix or remove it, then re-run.`);
    this.name = 'OpenCodeConfigParseError';
  }
}

/**
 * OpenCode's config file. `OPENCODE_CONFIG` wins when set; otherwise the
 * project-local `opencode.json` (falling back to `opencode.jsonc`) under the
 * given directory. OpenCode reads both JSON and JSONC, but Concord writes
 * plain JSON so a round-trip never has to preserve comments it did not add.
 */
export function opencodeConfigFile(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['OPENCODE_CONFIG']?.trim();
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  const jsonc = join(repoRoot, 'opencode.jsonc');
  if (!existsSync(join(repoRoot, 'opencode.json')) && existsSync(jsonc)) {
    return jsonc;
  }
  return join(repoRoot, 'opencode.json');
}

/**
 * Strip line comments, block comments, and trailing commas so a valid
 * `opencode.jsonc` file parses. Operates only outside string literals; a
 * comment marker inside a quoted value is left untouched.
 */
function stripJsonc(source: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next;
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    // A comma immediately followed by a closer is a trailing comma: drop it
    // here, where string state is known, rather than with a whole-text regex
    // that would also strip commas belonging to quoted values.
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/u.test(source[lookahead] ?? '')) lookahead += 1;
      const closer = source[lookahead] ?? '';
      if (closer === '}' || closer === ']') {
        continue;
      }
    }
    out += char;
  }
  return out;
}

function readConfig(path: string): JsonObject {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(readFileSync(path, 'utf8')));
  } catch {
    throw new OpenCodeConfigParseError(path);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OpenCodeConfigParseError(path);
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
    command: [CONCORD_SERVER_COMMAND],
    environment: { CONCORD_REPO_ROOT: repoRoot, CONCORD_AGENT_KIND },
    enabled: true,
  });
}

/** The `mcp` object, or `undefined` when it is absent or not an object. */
function readMcp(config: JsonObject, path: string): JsonObject | undefined {
  const mcp = config['mcp'];
  if (mcp === undefined) return undefined;
  const parsed = jsonObjectSchema.safeParse(mcp);
  if (!parsed.success) throw new OpenCodeConfigParseError(path);
  return parsed.data;
}

/** The `environment` object of an existing entry, narrowed to strings. */
function readEntryEnv(entry: JsonValue | undefined): Record<string, string> | undefined {
  if (entry === undefined) return undefined;
  const entryObject = jsonObjectSchema.safeParse(entry);
  if (!entryObject.success) return undefined;
  const environment = entryObject.data['environment'];
  if (environment === undefined) return undefined;
  const parsed = stringRecordSchema.safeParse(environment);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Idempotently add (or refresh) Concord's server entry in an OpenCode
 * `opencode.json`. Every other server and every unrelated top-level key is
 * preserved, and passing the previous output back in is a no-op. Returns the
 * absolute config path.
 */
export function installOpencodeMcpConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = opencodeConfigFile(repoRoot, env);
  const config = readConfig(path);
  const existingMcp = readMcp(config, path) ?? {};

  // Preserve a repo root already pinned by a previous setup when this run
  // targets a different root, keep any unrelated env the user added, and only
  // refresh the two managed keys.
  const existingEnv = readEntryEnv(existingMcp[CONCORD_OPENCODE_SERVER_KEY]);
  const pinnedRoot = existingEnv?.['CONCORD_REPO_ROOT'];
  const preservedRepoRoot = typeof pinnedRoot === 'string' ? pinnedRoot : repoRoot;

  const entry = concordServerEntryObject(preservedRepoRoot);
  const mergedEnv: Record<string, string> = { ...existingEnv, ...entry.environment };
  const mcp: JsonObject = {
    ...existingMcp,
    [CONCORD_OPENCODE_SERVER_KEY]: { ...entry, environment: mergedEnv },
  };
  writeConfig(path, { ...config, mcp });
  return path;
}

/** Whether Concord's server is currently registered with OpenCode. */
export function opencodeConfigInstalled(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const path = opencodeConfigFile(repoRoot, env);
  if (!existsSync(path)) return false;
  try {
    const mcp = readMcp(readConfig(path), path);
    const entry = jsonObjectSchema.safeParse(mcp?.[CONCORD_OPENCODE_SERVER_KEY]);
    if (!entry.success) return false;
    // An explicitly disabled entry is registered but will not be started, so
    // it is not "installed" for delivery purposes.
    if (entry.data['enabled'] === false) return false;
    const command = entry.data['command'];
    return Array.isArray(command) && command[0] === CONCORD_SERVER_COMMAND;
  } catch {
    return false;
  }
}

/** Remove only Concord's own entry; every other server and key is preserved. */
export function uninstallOpencodeConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = opencodeConfigFile(repoRoot, env);
  if (!existsSync(path)) return;
  let config: JsonObject;
  try {
    config = readConfig(path);
  } catch {
    // A malformed config is left untouched rather than aborting the whole
    // adapter uninstall, which must finish cleaning up the other harnesses.
    return;
  }
  const mcp = readMcp(config, path);
  if (mcp === undefined || !(CONCORD_OPENCODE_SERVER_KEY in mcp)) return;

  const next: JsonObject = {};
  for (const [key, value] of Object.entries(mcp)) {
    if (key === CONCORD_OPENCODE_SERVER_KEY) continue;
    next[key] = value;
  }
  writeConfig(path, { ...config, mcp: next });
}
