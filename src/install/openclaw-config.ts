import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import JSON5 from 'json5';
import { z } from 'zod';

import { userHome } from '../config/paths.js';
import { CONCORD_SERVER_COMMAND, CONCORD_SERVER_KEY, isConcordWrittenEntry } from './mcp-config.js';
import { concordServerLaunch } from './server-launch.js';

const MCP_KEY = 'mcp';
const SERVERS_KEY = 'servers';
export const OPENCLAW_KIND = 'openclaw';
const DEFAULT_AGENT_ID = 'main';

const looseObjectSchema = z.record(z.string(), z.unknown());
type UnknownRecord = z.infer<typeof looseObjectSchema>;

/** `~` at the start of an OpenClaw path means the user's home, as OpenClaw itself reads it. */
function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  if (path === '~') return userHome(env);
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(userHome(env), path.slice(2));
  return path;
}

function configuredPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : expandHome(value, env);
}

/** OpenClaw's state directory: `OPENCLAW_STATE_DIR`, or `~/.openclaw`. */
export function openclawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return configuredPath(env, 'OPENCLAW_STATE_DIR') ?? join(userHome(env), '.openclaw');
}

/** OpenClaw's JSON5 config: `OPENCLAW_CONFIG_PATH`, or `openclaw.json` in the state directory. */
export function openclawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    configuredPath(env, 'OPENCLAW_CONFIG_PATH') ?? join(openclawStateDir(env), 'openclaw.json')
  );
}

/** Whether OpenClaw has ever run here, for machines where its CLI is not on PATH. */
export function openclawStateDirExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(openclawStateDir(env));
}

function readConfig(path: string): UnknownRecord {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON5.parse(readFileSync(path, 'utf8'));
  return looseObjectSchema.parse(parsed);
}

/** Written as JSON, which OpenClaw reads as JSON5; comments in the original are not kept. */
function writeConfig(path: string, config: UnknownRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function mappingOrThrow(value: unknown, name: string): UnknownRecord {
  if (value === undefined) return {};
  const parsed = looseObjectSchema.safeParse(value);
  if (!parsed.success) throw new Error(`OpenClaw \`${name}\` configuration must be a mapping.`);
  return parsed.data;
}

/** The `mcp.servers` mapping of a config, or an error naming what is not a mapping. */
function mcpServers(config: UnknownRecord): { mcp: UnknownRecord; servers: UnknownRecord } {
  const mcp = mappingOrThrow(config[MCP_KEY], MCP_KEY);
  return { mcp, servers: mappingOrThrow(mcp[SERVERS_KEY], `${MCP_KEY}.${SERVERS_KEY}`) };
}

/** An entry Concord wrote: npx running the package, or the standalone launcher. */
function isConcordOpenclawEntry(entry: unknown): boolean {
  if (isConcordWrittenEntry(entry)) return true;
  const parsed = z.object({ command: z.string() }).loose().safeParse(entry);
  return parsed.success && basename(parsed.data.command) === CONCORD_SERVER_COMMAND;
}

export function openclawConfigInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const { servers } = mcpServers(readConfig(openclawConfigPath(env)));
    const entry = looseObjectSchema.safeParse(servers[CONCORD_SERVER_KEY]);
    return entry.success && entry.data['enabled'] !== false;
  } catch {
    return false;
  }
}

/** Register Concord under `mcp.servers.concord`, leaving a user's own entry of that name alone. */
export function installOpenclawMcpConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = openclawConfigPath(env);
  const config = readConfig(path);
  const { mcp, servers } = mcpServers(config);
  const current = servers[CONCORD_SERVER_KEY];
  if (current !== undefined && !isConcordOpenclawEntry(current)) return;
  const launch = concordServerLaunch();
  const entry = {
    command: launch.command,
    args: launch.args,
    env: { CONCORD_AGENT_KIND: OPENCLAW_KIND },
    enabled: true,
  };
  writeConfig(path, {
    ...config,
    [MCP_KEY]: { ...mcp, [SERVERS_KEY]: { ...servers, [CONCORD_SERVER_KEY]: entry } },
  });
}

/** Remove the entry Concord wrote; a user's own `concord` server stays. */
export function uninstallOpenclawConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = openclawConfigPath(env);
  if (!existsSync(path)) return;
  const config = readConfig(path);
  const { mcp, servers } = mcpServers(config);
  const current = servers[CONCORD_SERVER_KEY];
  if (current === undefined || !isConcordOpenclawEntry(current)) return;
  const next: UnknownRecord = {};
  for (const [key, value] of Object.entries(servers)) {
    if (key !== CONCORD_SERVER_KEY) next[key] = value;
  }
  writeConfig(path, { ...config, [MCP_KEY]: { ...mcp, [SERVERS_KEY]: next } });
}

/** One OpenClaw agent and the workspace whose `AGENTS.md` it reads. */
export interface OpenclawAgentWorkspace {
  agentId: string;
  workspace: string;
}

const agentsSchema = z
  .object({
    defaults: z.object({ workspace: z.string().optional() }).loose().optional(),
    entries: z
      .record(
        z.string(),
        z.object({ workspace: z.string().optional(), default: z.boolean().optional() }).loose(),
      )
      .optional(),
    list: z
      .array(
        z
          .object({
            id: z.string(),
            workspace: z.string().optional(),
            default: z.boolean().optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

/**
 * Every configured OpenClaw agent with its workspace, following OpenClaw's own
 * resolution: the default agent gets `OPENCLAW_WORKSPACE_DIR`, then
 * `agents.defaults.workspace`, then `<state dir>/workspace`; the others get
 * `<agents.defaults.workspace>/<id>` or `<state dir>/workspace-<id>`. An entry's
 * own `workspace` wins. Never throws: an unreadable config yields the default agent.
 */
export function openclawAgentWorkspaces(
  env: NodeJS.ProcessEnv = process.env,
): OpenclawAgentWorkspace[] {
  const stateDir = openclawStateDir(env);
  let agents: z.infer<typeof agentsSchema> = {};
  try {
    const parsed = agentsSchema.safeParse(readConfig(openclawConfigPath(env))['agents']);
    if (parsed.success) agents = parsed.data;
  } catch {
    // An unreadable config still has a default agent.
  }
  const sharedRoot = agents.defaults?.workspace;
  const defaultWorkspace =
    configuredPath(env, 'OPENCLAW_WORKSPACE_DIR') ??
    (sharedRoot === undefined ? join(stateDir, 'workspace') : expandHome(sharedRoot, env));
  const roster = [
    ...Object.entries(agents.entries ?? {}).map(([id, entry]) => ({ id, ...entry })),
    ...(agents.list ?? []),
  ];
  if (roster.length === 0) return [{ agentId: DEFAULT_AGENT_ID, workspace: defaultWorkspace }];
  const defaultId =
    roster.find((entry) => entry.default === true)?.id ??
    roster.find((entry) => entry.id === DEFAULT_AGENT_ID)?.id ??
    roster[0]?.id;
  return roster.map(({ id, workspace }) => ({
    agentId: id,
    workspace:
      workspace !== undefined
        ? expandHome(workspace, env)
        : id === defaultId || roster.length === 1
          ? defaultWorkspace
          : sharedRoot === undefined
            ? join(stateDir, `workspace-${id}`)
            : join(expandHome(sharedRoot, env), id),
  }));
}
