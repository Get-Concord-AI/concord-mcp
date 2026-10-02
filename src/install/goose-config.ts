import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';
import { dump, load } from 'js-yaml';

const EXTENSIONS_KEY = 'extensions';
const CONCORD_EXTENSION_KEY = 'concord-relay';
const CONCORD_SERVER_COMMAND = 'npx';
const CONCORD_SERVER_ARGS = ['-y', '@concord-ai/concord-mcp'];

function homeFor(env: NodeJS.ProcessEnv): string {
  const home = env['HOME']?.trim();
  if (home !== undefined && home !== '') return home;
  const userProfile = env['USERPROFILE']?.trim();
  return userProfile === undefined || userProfile === '' ? homedir() : userProfile;
}

export function gooseConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env['APPDATA']?.trim();
  if (appData !== undefined && appData !== '') {
    return join(appData, 'Block', 'goose', 'config', 'config.yaml');
  }
  return join(homeFor(env), '.config', 'goose', 'config.yaml');
}

const looseObjectSchema = z.record(z.string(), z.unknown());

type UnknownRecord = z.infer<typeof looseObjectSchema>;

function readConfig(path: string): UnknownRecord {
  if (!existsSync(path)) return {};
  const parsed: unknown = load(readFileSync(path, 'utf8'));
  if (parsed === null || parsed === undefined) return {};
  return looseObjectSchema.parse(parsed);
}

function writeConfig(path: string, config: UnknownRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, dump(config, { lineWidth: 100, noRefs: true }), { mode: 0o600 });
}

export function gooseConfigInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = gooseConfigPath(env);
  if (!existsSync(path)) return false;
  try {
    const config = readConfig(path);
    const extensions = config[EXTENSIONS_KEY];
    const parsedExtensions = looseObjectSchema.safeParse(extensions);
    if (!parsedExtensions.success) return false;

    const parsedEntry = looseObjectSchema.safeParse(parsedExtensions.data[CONCORD_EXTENSION_KEY]);
    return parsedEntry.success && parsedEntry.data['enabled'] === true;
  } catch {
    return false;
  }
}

export function installGooseMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
): void {
  const path = gooseConfigPath(env);
  const config = readConfig(path);
  const currentExtensions = config[EXTENSIONS_KEY];

  const parsedExtensions =
    currentExtensions === undefined
      ? { success: true as const, data: {} }
      : looseObjectSchema.safeParse(currentExtensions);

  if (!parsedExtensions.success) {
    throw new Error('Goose extensions configuration must be a mapping.');
  }

  const nextExtensions: UnknownRecord = {
    ...parsedExtensions.data,
  };

  nextExtensions[CONCORD_EXTENSION_KEY] = {
    enabled: true,
    type: 'stdio',
    name: CONCORD_EXTENSION_KEY,
    description: 'Concord shared work-state for coding agents',
    cmd: CONCORD_SERVER_COMMAND,
    args: [...CONCORD_SERVER_ARGS],
    envs: repoRoot !== undefined ? { CONCORD_REPO_ROOT: repoRoot } : {},
    timeout: 300,
  };

  writeConfig(path, { ...config, [EXTENSIONS_KEY]: nextExtensions });
}

export function uninstallGooseConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = gooseConfigPath(env);
  if (!existsSync(path)) return;
  const config = readConfig(path);
  const extensions = config[EXTENSIONS_KEY];

  const parsedExtensions = looseObjectSchema.safeParse(extensions);
  if (!parsedExtensions.success) return;

  const next: UnknownRecord = {};
  for (const [key, value] of Object.entries(parsedExtensions.data)) {
    if (key === CONCORD_EXTENSION_KEY) continue;
    next[key] = value;
  }
  writeConfig(path, { ...config, [EXTENSIONS_KEY]: next });
}
