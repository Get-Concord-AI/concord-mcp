import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import JSON5 from 'json5';
import { z } from 'zod';

import { userHome } from '../config/paths.js';
import { jsonObjectSchema, type JsonObject, type JsonValue } from './json-value.js';
import { AGENT_KIND_ENV, agentKindEnv, CONCORD_SERVER_KEY } from './mcp-config.js';
import { concordServerLaunch, NPX_SERVER_ARGS } from './server-launch.js';

export function expandOpenclawHome(path: string, env: NodeJS.ProcessEnv): string {
  const home = env['OPENCLAW_HOME']?.trim() || userHome(env);
  if (path === '~') return home;
  if (/^~[/\\]/u.test(path)) return join(home, path.slice(2));
  return path;
}

function configuredPath(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const path = value?.trim();
  return path === undefined || path === '' ? undefined : expandOpenclawHome(path, env);
}

export function openclawStateDir(env: NodeJS.ProcessEnv): string {
  const profile = env['OPENCLAW_PROFILE']?.trim();
  const suffix =
    profile !== undefined && /^[a-z0-9_-]+$/iu.test(profile) && profile.toLowerCase() !== 'default'
      ? `-${profile}`
      : '';
  return (
    configuredPath(env['OPENCLAW_STATE_DIR'], env) ??
    join(expandOpenclawHome('~', env), `.openclaw${suffix}`)
  );
}

export function openclawConfigPath(env: NodeJS.ProcessEnv): string {
  return (
    configuredPath(env['OPENCLAW_CONFIG_PATH'], env) ?? join(openclawStateDir(env), 'openclaw.json')
  );
}

export function readOpenclawConfig(env: NodeJS.ProcessEnv): JsonObject {
  const path = openclawConfigPath(env);
  if (!existsSync(path)) return {};
  return jsonObjectSchema.parse(JSON5.parse(readFileSync(path, 'utf8')));
}

function mapping(value: JsonValue | undefined, path: string): JsonObject {
  if (value === undefined) return {};
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) throw new Error(`OpenClaw \`${path}\` configuration must be a mapping.`);
  return parsed.data;
}

function mcpServers(config: JsonObject): { mcp: JsonObject; servers: JsonObject } {
  const mcp = mapping(config['mcp'], 'mcp');
  const servers = mapping(mcp['servers'], 'mcp.servers');
  if ([config, mcp, servers].some((section) => '$include' in section)) {
    throw new Error(
      'OpenClaw MCP config uses $include. Manage the Concord entry with openclaw mcp.',
    );
  }
  return { mcp, servers };
}

const managedEntrySchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.strictObject({ [AGENT_KIND_ENV]: z.literal('openclaw') }),
  enabled: z.literal(true).optional(),
});

function isManagedEntry(entry: JsonValue | undefined): boolean {
  const parsed = managedEntrySchema.safeParse(entry);
  if (!parsed.success) return false;
  const { command, args } = parsed.data;
  return (
    (basename(command) === 'concord-mcp' && args.length === 0) ||
    (command === 'npx' &&
      args.length === NPX_SERVER_ARGS.length &&
      NPX_SERVER_ARGS.every((arg, index) => args[index] === arg))
  );
}

function writeConfig(path: string, config: JsonObject): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function openclawConfigInstalled(env: NodeJS.ProcessEnv): boolean {
  try {
    const { servers } = mcpServers(readOpenclawConfig(env));
    const entry = jsonObjectSchema.safeParse(servers[CONCORD_SERVER_KEY]);
    return entry.success && entry.data['enabled'] !== false;
  } catch {
    return false;
  }
}

/** OpenClaw accepts JSON5; changed files are written back as JSON. */
export function installOpenclawMcpConfig(env: NodeJS.ProcessEnv): void {
  const config = readOpenclawConfig(env);
  const { mcp, servers } = mcpServers(config);
  const current = servers[CONCORD_SERVER_KEY];
  if (current !== undefined && !isManagedEntry(current)) return;
  const { command, args } = concordServerLaunch();
  if (isManagedEntry(current)) {
    const existing = managedEntrySchema.parse(current);
    if (
      existing.command === command &&
      existing.enabled === true &&
      existing.args.length === args.length &&
      args.every((arg, index) => existing.args[index] === arg)
    )
      return;
  }
  servers[CONCORD_SERVER_KEY] = { command, args, env: agentKindEnv('openclaw'), enabled: true };
  writeConfig(openclawConfigPath(env), { ...config, mcp: { ...mcp, servers } });
}

export function uninstallOpenclawConfig(env: NodeJS.ProcessEnv): void {
  const config = readOpenclawConfig(env);
  const { mcp, servers } = mcpServers(config);
  if (!isManagedEntry(servers[CONCORD_SERVER_KEY])) return;
  const kept = Object.fromEntries(
    Object.entries(servers).filter(([key]) => key !== CONCORD_SERVER_KEY),
  );
  writeConfig(openclawConfigPath(env), { ...config, mcp: { ...mcp, servers: kept } });
}
