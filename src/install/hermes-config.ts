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
    return (
      entry.success &&
      entry.data['enabled'] !== false &&
      entry.data['command'] === 'npx' &&
      Array.isArray(entry.data['args']) &&
      entry.data['args'].includes('@concord-ai/concord-mcp')
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
  writeConfig(path, {
    ...config,
    mcp_servers: {
      ...servers,
      [SERVER_KEY]: {
        command: 'npx',
        args: ['-y', '@concord-ai/concord-mcp'],
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
