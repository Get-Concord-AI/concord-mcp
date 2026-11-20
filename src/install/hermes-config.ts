import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { dump, load } from 'js-yaml';
import { z } from 'zod';

import { standaloneInstall } from '../config/install-mode.js';
import { userHome } from '../config/paths.js';

/**
 * Hermes Agent's user-level registration, all in `$HERMES_HOME/config.yaml`:
 * the Concord MCP server and one `pre_llm_call` shell hook.
 *
 * Hermes starts MCP servers once per process, from `$HOME`, before any session
 * exists, and one gateway process serves every session. The server therefore
 * cannot learn a session id or a project from its environment, and none is
 * pinned here: `${workspaceFolder}` resolves to `$HOME` at that point, which
 * would send every project's work to one home-directory workspace. The hook
 * runs per turn with the session id, so it is what tells the model which
 * `agent_id` and `workspace_id` to pass (see `cli/commands/hermes-hooks.ts`).
 *
 * Hermes asks the user to approve a shell hook the first time it would run;
 * Concord leaves that consent to Hermes, as it does Codex's hook trust.
 */

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
const yamlValueSchema: z.ZodType<YamlValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(yamlValueSchema),
    z.record(z.string(), yamlValueSchema),
  ]),
);
const mappingSchema = z.record(z.string(), yamlValueSchema);
type Mapping = z.infer<typeof mappingSchema>;
const hookListSchema = z.array(yamlValueSchema);

const SERVER_KEY = 'concord';
const NPX_SERVER_ARGS = ['-y', '@concord-ai/concord-mcp'];
const SERVER_ENV = { CONCORD_AGENT_KIND: 'hermes' };
/** Keys earlier Concord releases wrote into the server env, which pinned `$HOME`. */
const STALE_ENV_KEYS = new Set(['HERMES_SESSION_ID', 'CONCORD_REPO_ROOT']);
export const HERMES_HOOK_EVENT = 'pre_llm_call';
export const HERMES_HOOK_COMMAND = 'concord hook hermes-pre-llm-call';
const HOOK_TIMEOUT_SECONDS = 30;

/** Standalone installs launch directly: they may have neither npm nor npx on PATH. */
function concordServerLaunch(): { command: string; args: string[] } {
  const standalone = standaloneInstall();
  return standalone === undefined
    ? { command: 'npx', args: [...NPX_SERVER_ARGS] }
    : { command: join(standalone.binDir, 'concord-mcp'), args: [] };
}

/** Hermes' data root: `HERMES_HOME` when set, else `~/.hermes`. */
export function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['HERMES_HOME']?.trim();
  return configured === undefined || configured === ''
    ? join(userHome(env), '.hermes')
    : configured;
}

export function hermesConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hermesHome(env), 'config.yaml');
}

function readConfig(path: string): Mapping {
  if (!existsSync(path)) return {};
  const parsed: unknown = load(readFileSync(path, 'utf8'));
  if (parsed === null || parsed === undefined) return {};
  return mappingSchema.parse(parsed);
}

function resolveConfigTarget(path: string): string {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path));
      return existsSync(target) ? realpathSync(target) : target;
    }
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

function writeConfig(path: string, config: Mapping): void {
  const target = resolveConfigTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  // A unique, exclusive temporary file prevents clobbering a pre-existing file or symlink.
  const temporary = `${target}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    temporaryCreated = true;
    try {
      writeFileSync(fd, dump(config, { lineWidth: 100, noRefs: true }));
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } finally {
    if (temporaryCreated) rmSync(temporary, { force: true });
  }
}

function isConcordHook(entry: YamlValue): boolean {
  const parsed = mappingSchema.safeParse(entry);
  return parsed.success && parsed.data['command'] === HERMES_HOOK_COMMAND;
}

/** The config's `hooks:` with Concord's entry removed from every event. */
function hooksWithoutConcord(config: Mapping): Mapping {
  const existing = config['hooks'];
  const hooks = existing === undefined || existing === null ? {} : mappingSchema.parse(existing);
  const kept: Mapping = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const list = hookListSchema.safeParse(entries);
    if (!list.success) {
      kept[event] = entries;
      continue;
    }
    const remaining = list.data.filter((entry) => !isConcordHook(entry));
    if (remaining.length > 0) kept[event] = remaining;
  }
  return kept;
}

function serverInstalled(config: Mapping): boolean {
  const servers = mappingSchema.safeParse(config['mcp_servers']);
  if (!servers.success) return false;
  const entry = mappingSchema.safeParse(servers.data[SERVER_KEY]);
  if (!entry.success) return false;
  const launcher = concordServerLaunch();
  const args = entry.data['args'];
  const serverEnv = mappingSchema.safeParse(entry.data['env']);
  return (
    entry.data['enabled'] !== false &&
    entry.data['command'] === launcher.command &&
    Array.isArray(args) &&
    (launcher.command === 'npx' ? args.includes('@concord-ai/concord-mcp') : args.length === 0) &&
    serverEnv.success &&
    serverEnv.data['CONCORD_AGENT_KIND'] === 'hermes' &&
    !Object.keys(serverEnv.data).some((key) => STALE_ENV_KEYS.has(key))
  );
}

function hookInstalled(config: Mapping): boolean {
  const hooks = mappingSchema.safeParse(config['hooks']);
  if (!hooks.success) return false;
  const entries = hookListSchema.safeParse(hooks.data[HERMES_HOOK_EVENT]);
  return entries.success && entries.data.some(isConcordHook);
}

export function hermesConfigInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = hermesConfigPath(env);
  if (!existsSync(path)) return false;
  try {
    const config = readConfig(path);
    return serverInstalled(config) && hookInstalled(config);
  } catch {
    return false;
  }
}

export function installHermesMcpConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = hermesConfigPath(env);
  const config = readConfig(path);
  const existing = config['mcp_servers'];
  const servers = existing === undefined || existing === null ? {} : mappingSchema.parse(existing);
  const previous = mappingSchema.safeParse(servers[SERVER_KEY]);
  const previousEnv = previous.success ? mappingSchema.safeParse(previous.data['env']) : undefined;
  const keptEnv = Object.fromEntries(
    Object.entries(previousEnv?.success ? previousEnv.data : {}).filter(
      ([key]) => !STALE_ENV_KEYS.has(key),
    ),
  );
  const hooks = hooksWithoutConcord(config);
  const eventHooks = hookListSchema.safeParse(hooks[HERMES_HOOK_EVENT]);
  writeConfig(path, {
    ...config,
    mcp_servers: {
      ...servers,
      [SERVER_KEY]: {
        ...(previous.success ? previous.data : {}),
        ...concordServerLaunch(),
        env: { ...keptEnv, ...SERVER_ENV },
        enabled: true,
      },
    },
    hooks: {
      ...hooks,
      [HERMES_HOOK_EVENT]: [
        ...(eventHooks.success ? eventHooks.data : []),
        { command: HERMES_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS },
      ],
    },
  });
}

export function uninstallHermesMcpConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = hermesConfigPath(env);
  if (!existsSync(path)) return;
  const config = readConfig(path);
  const servers = mappingSchema.safeParse(config['mcp_servers']);
  const hasServer = servers.success && SERVER_KEY in servers.data;
  const hasHook = mappingSchema.safeParse(config['hooks']).success && hookInstalled(config);
  if (!hasServer && !hasHook) return;
  const next: Mapping = { ...config };
  if (servers.success && hasServer) {
    next['mcp_servers'] = Object.fromEntries(
      Object.entries(servers.data).filter(([key]) => key !== SERVER_KEY),
    );
  }
  if (hasHook) {
    const hooks = hooksWithoutConcord(config);
    if (Object.keys(hooks).length === 0) delete next['hooks'];
    else next['hooks'] = hooks;
  }
  writeConfig(path, next);
}
