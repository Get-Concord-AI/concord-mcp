import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';
import { agentKindEnv, CONCORD_SERVER_COMMAND, isConcordWrittenEntry } from './mcp-config.js';

const MCP_SERVERS_KEY = 'mcp_servers';
const CONCORD_SERVER_KEY = 'concord';

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const objectSchema = z.record(z.string(), jsonValueSchema);

export function museHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['MUSE_HOME']?.trim();
  if (configured !== undefined && configured !== '') return configured;
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  if (xdg !== undefined && xdg !== '') return join(xdg, 'muse');
  return join(userHome(env), '.config', 'muse');
}

export function museConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(museHome(env), 'settings.json');
}

function parseConfig(text: string, configPath: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const topLevel = objectSchema.safeParse(parsed);
  if (!topLevel.success) {
    throw new Error(`${configPath} must be a JSON object.`);
  }
  return topLevel.data;
}

export function hasMuseCodeMcpServer(existing: string): boolean {
  try {
    if (existing.trim() === '') return false;
    const config = parseConfig(existing, 'settings.json');
    const servers = objectSchema.safeParse(config[MCP_SERVERS_KEY]);
    return servers.success && CONCORD_SERVER_KEY in servers.data;
  } catch {
    return false;
  }
}

export function upsertMuseCodeMcpServer(
  existing: string | undefined,
  configPath = 'settings.json',
): string {
  if (existing === undefined || existing.trim() === '') {
    const initial: JsonObject = {
      schema_version: 1,
      [MCP_SERVERS_KEY]: {
        [CONCORD_SERVER_KEY]: {
          command: CONCORD_SERVER_COMMAND,
          env: agentKindEnv('muse-code'),
        },
      },
    };
    return `${JSON.stringify(initial, null, 2)}\n`;
  }

  const config = parseConfig(existing, configPath);
  const currentServers = config[MCP_SERVERS_KEY];
  let nextServers: JsonObject = {};
  if (currentServers !== undefined) {
    const parsedServers = objectSchema.safeParse(currentServers);
    if (!parsedServers.success) {
      throw new Error(`${configPath} property "${MCP_SERVERS_KEY}" must be a JSON object.`);
    }
    const entry = parsedServers.data[CONCORD_SERVER_KEY];
    if (entry !== undefined && !isConcordWrittenEntry(entry)) {
      return existing;
    }
    nextServers = { ...parsedServers.data };
  }

  nextServers[CONCORD_SERVER_KEY] = {
    command: CONCORD_SERVER_COMMAND,
    env: agentKindEnv('muse-code'),
  };
  const next: JsonObject = {
    schema_version: config['schema_version'] ?? 1,
    ...config,
    [MCP_SERVERS_KEY]: nextServers,
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function removeMuseCodeMcpServer(existing: string, configPath = 'settings.json'): string {
  if (existing.trim() === '') return '';
  const config = parseConfig(existing, configPath);
  const currentServers = config[MCP_SERVERS_KEY];
  if (currentServers === undefined) return existing;
  const parsedServers = objectSchema.safeParse(currentServers);
  if (!parsedServers.success) return existing;

  const entry = parsedServers.data[CONCORD_SERVER_KEY];
  if (entry === undefined || !isConcordWrittenEntry(entry)) return existing;

  const nextServers: JsonObject = {};
  for (const [key, value] of Object.entries(parsedServers.data)) {
    if (key !== CONCORD_SERVER_KEY) nextServers[key] = value;
  }

  const otherKeys = Object.keys(config).filter(
    (key) => key !== MCP_SERVERS_KEY && key !== 'schema_version',
  );
  if (otherKeys.length === 0 && Object.keys(nextServers).length === 0) return '';

  return `${JSON.stringify({ ...config, [MCP_SERVERS_KEY]: nextServers }, null, 2)}\n`;
}

export function museCodeConfigInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = museConfigPath(env);
  if (!existsSync(path)) return false;
  try {
    return hasMuseCodeMcpServer(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

export function installMuseCodeMcpConfig(env: NodeJS.ProcessEnv = process.env): string {
  const path = museConfigPath(env);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const next = upsertMuseCodeMcpServer(existing, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return path;
}

export function uninstallMuseCodeConfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = museConfigPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const existing = readFileSync(path, 'utf8');
    const next = removeMuseCodeMcpServer(existing, path);
    if (next === existing) return path;
    if (next === '') rmSync(path);
    else writeFileSync(path, next);
    return path;
  } catch {
    // Unreadable or malformed config is left untouched.
    return undefined;
  }
}
