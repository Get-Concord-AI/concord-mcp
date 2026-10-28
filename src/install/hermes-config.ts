import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { dump, load } from 'js-yaml';
import { z } from 'zod';

import { standaloneInstall } from '../config/install-mode.js';
import { userHome } from '../config/paths.js';

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
const SERVER_KEY = 'concord';
const NPX_SERVER_ARGS = ['-y', '@concord-ai/concord-mcp'];
const HERMES_AGENT_ID = 'hermes:${HERMES_SESSION_ID}';
const HERMES_WORKSPACE = '${workspaceFolder}';
const HERMES_SERVER_ENV = {
  CONCORD_AGENT_ID: HERMES_AGENT_ID,
  CONCORD_AGENT_KIND: 'hermes',
  CONCORD_REPO_ROOT: HERMES_WORKSPACE,
};

/** Standalone installs launch directly: they may have neither npm nor npx on PATH. */
function concordServerLaunch(): { command: string; args: string[] } {
  const standalone = standaloneInstall();
  return standalone === undefined
    ? { command: 'npx', args: [...NPX_SERVER_ARGS] }
    : { command: join(standalone.binDir, 'concord-mcp'), args: [] };
}

export function hermesConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['HERMES_HOME']?.trim();
  return join(
    configured === undefined || configured === '' ? join(userHome(env), '.hermes') : configured,
    'config.yaml',
  );
}

function readConfig(path: string): Mapping {
  if (!existsSync(path)) return {};
  const parsed: unknown = load(readFileSync(path, 'utf8'));
  if (parsed === null || parsed === undefined) return {};
  return mappingSchema.parse(parsed);
}

function writeConfig(path: string, config: Mapping): void {
  const target = existsSync(path) ? realpathSync(path) : path;
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

export function hermesConfigInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = hermesConfigPath(env);
  if (!existsSync(path)) return false;
  try {
    const servers = mappingSchema.safeParse(readConfig(path)['mcp_servers']);
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
      serverEnv.data['CONCORD_AGENT_ID'] === HERMES_AGENT_ID &&
      serverEnv.data['CONCORD_AGENT_KIND'] === 'hermes' &&
      serverEnv.data['CONCORD_REPO_ROOT'] === HERMES_WORKSPACE
    );
  } catch {
    return false;
  }
}

export function installHermesMcpConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = hermesConfigPath(env);
  const config = readConfig(path);
  const existing = config['mcp_servers'];
  const servers = existing === undefined ? {} : mappingSchema.parse(existing);
  const previous = mappingSchema.safeParse(servers[SERVER_KEY]);
  const previousEnv = previous.success ? mappingSchema.safeParse(previous.data['env']) : undefined;
  const mergedEnv = previousEnv?.success ? previousEnv.data : {};
  writeConfig(path, {
    ...config,
    mcp_servers: {
      ...servers,
      [SERVER_KEY]: {
        ...(previous.success ? previous.data : {}),
        ...concordServerLaunch(),
        env: { ...mergedEnv, ...HERMES_SERVER_ENV },
        enabled: true,
      },
    },
  });
}

export function uninstallHermesMcpConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = hermesConfigPath(env);
  if (!existsSync(path)) return;
  const config = readConfig(path);
  const servers = mappingSchema.safeParse(config['mcp_servers']);
  if (!servers.success || !(SERVER_KEY in servers.data)) return;
  const next: Mapping = Object.fromEntries(
    Object.entries(servers.data).filter(([key]) => key !== SERVER_KEY),
  );
  writeConfig(path, { ...config, mcp_servers: next });
}
