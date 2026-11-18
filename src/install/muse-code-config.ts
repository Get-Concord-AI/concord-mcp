import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userHome } from '../config/paths.js';
import {
  agentKindEnv,
  CONCORD_SERVER_COMMAND,
  isConcordServerEntry,
  isConcordWrittenEntry,
} from './mcp-config.js';
import { type JsonObject, type JsonValue, jsonObjectSchema, parseJsonObject } from './json.js';

const MCP_SERVERS_KEY = 'mcpServers';
const MCP_SERVERS_LEGACY_KEY = 'mcp_servers';
const CONCORD_SERVER_KEY = 'concord';

export function museHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  if (xdg !== undefined && xdg !== '') return join(xdg, 'muse');
  return join(userHome(env), '.config', 'muse');
}

export function museConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(museHome(env), 'settings.json');
}

function parseConfig(text: string, configPath: string): JsonObject {
  return parseJsonObject(text, configPath);
}

function hasBothRootKeys(config: JsonObject): boolean {
  return MCP_SERVERS_KEY in config && MCP_SERVERS_LEGACY_KEY in config;
}

function entryHasConflictingSpellings(entry: JsonObject): boolean {
  return ('transport' in entry && 'type' in entry) || ('mode' in entry && 'required' in entry);
}

function concordEntryFromConfig(config: JsonObject):
  | {
      key: string;
      entry: unknown;
    }
  | undefined {
  const canonical = config[MCP_SERVERS_KEY];
  if (canonical !== undefined) {
    const parsed = jsonObjectSchema.safeParse(canonical);
    if (parsed.success && CONCORD_SERVER_KEY in parsed.data) {
      return { key: MCP_SERVERS_KEY, entry: parsed.data[CONCORD_SERVER_KEY] };
    }
  }
  const legacy = config[MCP_SERVERS_LEGACY_KEY];
  if (legacy !== undefined) {
    const parsed = jsonObjectSchema.safeParse(legacy);
    if (parsed.success && CONCORD_SERVER_KEY in parsed.data) {
      return { key: MCP_SERVERS_LEGACY_KEY, entry: parsed.data[CONCORD_SERVER_KEY] };
    }
  }
  return undefined;
}

export function hasMuseCodeMcpServer(existing: string): boolean {
  try {
    if (existing.trim() === '') return false;
    const config = parseConfig(existing, 'settings.json');
    if (hasBothRootKeys(config)) return false;
    const found = concordEntryFromConfig(config);
    if (found === undefined) return false;
    const entryObj = jsonObjectSchema.safeParse(found.entry);
    if (!entryObj.success) return false;
    if (entryHasConflictingSpellings(entryObj.data)) return false;
    return isConcordServerEntry(found.entry);
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
          transport: 'stdio',
          command: CONCORD_SERVER_COMMAND,
          env: agentKindEnv('muse-code'),
          mode: 'optional',
        },
      },
    };
    return `${JSON.stringify(initial, null, 2)}\n`;
  }

  const config = parseConfig(existing, configPath);
  if (hasBothRootKeys(config)) {
    throw new Error(
      `${configPath} has both "${MCP_SERVERS_KEY}" and "${MCP_SERVERS_LEGACY_KEY}". Muse disables MCP when both keys are present; merge them into a single "${MCP_SERVERS_KEY}" object and re-run.`,
    );
  }

  const hasLegacyOnly = MCP_SERVERS_LEGACY_KEY in config && !(MCP_SERVERS_KEY in config);
  const targetKey = hasLegacyOnly ? MCP_SERVERS_LEGACY_KEY : MCP_SERVERS_KEY;

  const currentServersRaw = config[targetKey];
  let nextServers: JsonObject = {};
  if (currentServersRaw !== undefined) {
    const parsedServers = jsonObjectSchema.safeParse(currentServersRaw);
    if (!parsedServers.success) {
      throw new Error(`${configPath} property "${targetKey}" must be a JSON object.`);
    }
    const entry = parsedServers.data[CONCORD_SERVER_KEY];
    if (entry !== undefined && !isConcordWrittenEntry(entry)) {
      return existing;
    }
    nextServers = { ...parsedServers.data };
  }

  nextServers[CONCORD_SERVER_KEY] = {
    transport: 'stdio',
    command: CONCORD_SERVER_COMMAND,
    env: agentKindEnv('muse-code'),
    mode: 'optional',
  };
  const next: JsonObject = {
    schema_version: config['schema_version'] ?? 1,
    ...config,
    [targetKey]: nextServers,
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function removeMuseCodeMcpServer(existing: string, configPath = 'settings.json'): string {
  if (existing.trim() === '') return '';
  const config = parseConfig(existing, configPath);
  const found = concordEntryFromConfig(config);
  if (found !== undefined && !isConcordWrittenEntry(found.entry)) {
    return existing;
  }

  const removeConcordFrom = (serversRaw: JsonValue): JsonObject | undefined => {
    const parsed = jsonObjectSchema.safeParse(serversRaw);
    if (!parsed.success) return undefined;
    if (!(CONCORD_SERVER_KEY in parsed.data)) return undefined;
    const entry = parsed.data[CONCORD_SERVER_KEY];
    if (!isConcordWrittenEntry(entry)) return undefined;
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (k !== CONCORD_SERVER_KEY) out[k] = v;
    }
    return out;
  };

  let nextConfig: JsonObject = { ...config };
  let changed = false;

  if (MCP_SERVERS_KEY in config) {
    const nextServers = removeConcordFrom(config[MCP_SERVERS_KEY]);
    if (nextServers !== undefined) {
      changed = true;
      if (Object.keys(nextServers).length === 0) {
        const rest: JsonObject = {};
        for (const [k, v] of Object.entries(nextConfig)) {
          if (k !== MCP_SERVERS_KEY) rest[k] = v;
        }
        nextConfig = rest;
      } else {
        nextConfig = { ...nextConfig, [MCP_SERVERS_KEY]: nextServers };
      }
    }
  }
  if (MCP_SERVERS_LEGACY_KEY in config) {
    const nextServers = removeConcordFrom(config[MCP_SERVERS_LEGACY_KEY]);
    if (nextServers !== undefined) {
      changed = true;
      if (Object.keys(nextServers).length === 0) {
        const rest: JsonObject = {};
        for (const [k, v] of Object.entries(nextConfig)) {
          if (k !== MCP_SERVERS_LEGACY_KEY) rest[k] = v;
        }
        nextConfig = rest;
      } else {
        nextConfig = { ...nextConfig, [MCP_SERVERS_LEGACY_KEY]: nextServers };
      }
    }
  }

  if (!changed) return existing;
  const otherKeys = Object.keys(nextConfig).filter((key) => key !== 'schema_version');
  if (otherKeys.length === 0) return '';
  return `${JSON.stringify(nextConfig, null, 2)}\n`;
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
    return undefined;
  }
}
