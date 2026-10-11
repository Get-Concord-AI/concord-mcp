import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { CONCORD_DIR, userHome } from './paths.js';

/**
 * The machine-wide store: every repository that was never set up, plus
 * `general` for sessions outside any repository. Not `concord.db`, which is
 * what a session started in the home directory itself has always created.
 */
const GLOBAL_DB_FILENAME = 'global.db';
const USER_CONFIG_FILENAME = 'config.json';

const userConfigSchema = z
  .object({
    globalMode: z.boolean().optional(),
    globalRegistrations: z.array(z.string()).optional(),
  })
  .loose();
/** The whole file as JSON, so settings this version does not know survive a write. */
const storedConfigSchema = z.record(z.string(), z.json());

/** The user's choices, from `~/.concord/config.json`. */
export interface UserConfig {
  /** Use the machine-wide store outside set-up repositories; undefined until asked. */
  readonly globalMode?: boolean;
  /** The user-level MCP registrations global mode added: the only ones it removes. */
  readonly globalRegistrations?: readonly string[];
}

/** `~/.concord/`, home to the machine-wide store and the user's settings. */
export function userConcordDir(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), CONCORD_DIR);
}

export function globalDatabasePath(env: NodeJS.ProcessEnv): string {
  return join(userConcordDir(env), GLOBAL_DB_FILENAME);
}

function userConfigPath(env: NodeJS.ProcessEnv): string {
  return join(userConcordDir(env), USER_CONFIG_FILENAME);
}

/**
 * Read the user's settings. A missing or unreadable file reads as no choice
 * made: hooks run on every tool call and must not fail on a hand-edited file.
 */
export function readUserConfig(env: NodeJS.ProcessEnv): UserConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(userConfigPath(env), 'utf8'));
    const parsed = userConfigSchema.parse(raw);
    return {
      ...(parsed.globalMode === undefined ? {} : { globalMode: parsed.globalMode }),
      ...(parsed.globalRegistrations === undefined
        ? {}
        : { globalRegistrations: parsed.globalRegistrations }),
    };
  } catch {
    return {};
  }
}

/** Merge `update` into the user's settings, keeping any keys this version does not know. */
export function writeUserConfig(env: NodeJS.ProcessEnv, update: UserConfig): string {
  const path = userConfigPath(env);
  let current: z.infer<typeof storedConfigSchema> = {};
  try {
    current = storedConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // Missing or unreadable: start from the update alone.
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, ...update }, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  return path;
}
