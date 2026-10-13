import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';
import { CONCORD_SERVER_COMMAND, CONCORD_SERVER_KEY } from './mcp-config.js';

/** Pinned into Concord's own MCP registration so identity cannot borrow a parent harness. */
const CONCORD_AGENT_KIND = 'cline';

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), jsonArraySchema, jsonObjectSchema]),
);
const jsonArraySchema: z.ZodType<readonly JsonValue[]> = z.lazy(() => z.array(jsonValueSchema));
const jsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() => z.record(z.string(), jsonValueSchema));

type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

/** Existing settings were not JSON. The file is left untouched. */
export class ClineConfigParseError extends Error {
  constructor(readonly filePath: string) {
    super(`${filePath} is not valid JSON — fix or remove it, then re-run.`);
    this.name = 'ClineConfigParseError';
  }
}

function configured(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `CLINE_MCP_SETTINGS_PATH`, else `<CLINE_DATA_DIR or ~/.cline/data>/settings/cline_mcp_settings.json`. */
export function clineMcpSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = configured(env, 'CLINE_MCP_SETTINGS_PATH');
  if (explicit !== undefined) return explicit;
  const data = configured(env, 'CLINE_DATA_DIR') ?? join(clineDir(env), 'data');
  return join(data, 'settings', 'cline_mcp_settings.json');
}

function clineDir(env: NodeJS.ProcessEnv): string {
  return configured(env, 'CLINE_DIR') ?? join(userHome(env), '.cline');
}

function readConfig(path: string): JsonObject {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ClineConfigParseError(path);
  }
  const config = jsonObjectSchema.safeParse(parsed);
  if (!config.success) throw new ClineConfigParseError(path);
  return config.data;
}

function writeConfig(path: string, config: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function readServers(config: JsonObject, path: string): JsonObject {
  const servers = config['mcpServers'];
  if (servers === undefined) return {};
  const parsed = jsonObjectSchema.safeParse(servers);
  if (!parsed.success) throw new ClineConfigParseError(path);
  return parsed.data;
}

function readEntry(servers: JsonObject, path: string): JsonObject | undefined {
  const entry = servers[CONCORD_SERVER_KEY];
  if (entry === undefined) return undefined;
  const parsed = jsonObjectSchema.safeParse(entry);
  if (!parsed.success) throw new ClineConfigParseError(path);
  return parsed.data;
}

function readEnv(value: JsonValue | undefined, path: string): JsonObject {
  if (value === undefined) return {};
  const parsed = z.record(z.string(), z.string()).safeParse(value);
  if (!parsed.success) throw new ClineConfigParseError(path);
  return parsed.data;
}

function concordEntry(
  existing: JsonObject | undefined,
  repoRoot: string,
  path: string,
): JsonObject {
  const args = existing?.['args'];
  const preservedArgs =
    existing?.['command'] === CONCORD_SERVER_COMMAND && args !== undefined ? args : [];
  return {
    ...(existing ?? {}),
    command: CONCORD_SERVER_COMMAND,
    args: preservedArgs,
    env: {
      ...readEnv(existing?.['env'], path),
      CONCORD_REPO_ROOT: repoRoot,
      CONCORD_AGENT_KIND,
    },
    disabled: false,
  };
}

/** Merge Concord's server into Cline's settings. Other servers, keys, and env values stay. */
export function installClineMcpConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = clineMcpSettingsPath(env);
  const config = readConfig(path);
  const servers = readServers(config, path);
  const entry = concordEntry(readEntry(servers, path), repoRoot, path);
  writeConfig(path, { ...config, mcpServers: { ...servers, [CONCORD_SERVER_KEY]: entry } });
  return path;
}

/** True when Cline will start Concord. A disabled entry does not count. */
export function clineConfigInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = clineMcpSettingsPath(env);
  if (!existsSync(path)) return false;
  try {
    const entry = readEntry(readServers(readConfig(path), path), path);
    return entry?.['command'] === CONCORD_SERVER_COMMAND && entry['disabled'] !== true;
  } catch {
    return false;
  }
}

/** Remove only Concord's server. A malformed file is left untouched. */
export function uninstallClineConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = clineMcpSettingsPath(env);
  if (!existsSync(path)) return;
  try {
    const config = readConfig(path);
    const servers = readServers(config, path);
    if (!(CONCORD_SERVER_KEY in servers)) return;
    const next: JsonObject = {};
    for (const [key, value] of Object.entries(servers)) {
      if (key !== CONCORD_SERVER_KEY) next[key] = value;
    }
    writeConfig(path, { ...config, mcpServers: next });
  } catch {
    // Leave a malformed settings file for the operator to fix.
  }
}
