import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { concordDir, userHome } from '../config/paths.js';

/**
 * Where Concord Cloud mode is configured. Two files, deliberately separate:
 *
 * - **Credentials** (`~/.concord/credentials.json`, mode 0600) — the API URL and
 *   key. Per user, never in a repository: `.mcp.json` and friends are usually
 *   committed, and a key must not ride along.
 * - **Link** (`<repo>/.concord/cloud.json`) — that this repository works through
 *   the cloud, and as which project. Its presence is the switch for cloud mode;
 *   without it everything stays local, exactly as before.
 */

const credentialsSchema = z.object({
  apiUrl: z.url(),
  apiKey: z.string().min(1),
});
export type CloudCredentials = z.infer<typeof credentialsSchema>;

const linkSchema = z.object({
  apiUrl: z.url(),
  /** The repository's normalised git remote; see `normalizeProjectKey`. */
  projectKey: z.string().min(1),
});
export type CloudLink = z.infer<typeof linkSchema>;

export function credentialsPath(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.concord', 'credentials.json');
}

/**
 * This machine, as Concord Cloud knows it: registered at login and sent with
 * every call, so agents resolve per machine as they do locally. Kept apart from
 * the credentials so logging out forgets the key but not the machine.
 */
const machineSchema = z.object({ machineKey: z.string().min(1) });

export function machinePath(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.concord', 'machine.json');
}

export function readMachineKey(env: NodeJS.ProcessEnv): string | undefined {
  return readJson(machinePath(env), machineSchema)?.machineKey;
}

/**
 * This machine's key, minted and saved the first time one is needed. Created
 * exclusively, by linking a complete file into place, so two first logins at
 * once agree on one key: the loser reads the winner's.
 */
export function ensureMachineKey(env: NodeJS.ProcessEnv, mint: () => string): string {
  const saved = readMachineKey(env);
  if (saved !== undefined) return saved;

  const path = machinePath(env);
  const machineKey = mint();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ machineKey }, null, 2)}\n`, { mode: 0o644 });
  try {
    linkSync(temporary, path);
  } catch (error) {
    const winner = readMachineKey(env);
    if (winner === undefined) throw error;
    return winner;
  } finally {
    rmSync(temporary, { force: true });
  }
  return machineKey;
}

export function linkPath(repoRoot: string): string {
  return join(concordDir(repoRoot), 'cloud.json');
}

/** Reads a JSON file through a schema; a missing or unreadable file is absent. */
function readJson<T>(path: string, schema: z.ZodType<T>): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes through a new file renamed into place: an interrupted write leaves the
 * old file whole, and a secret is never in a file anyone else can read, since
 * the new file is created with its mode rather than changed to it afterwards.
 */
function writeJson(path: string, value: object, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  rmSync(temporary, { force: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readCredentials(env: NodeJS.ProcessEnv): CloudCredentials | undefined {
  return readJson(credentialsPath(env), credentialsSchema);
}

export function writeCredentials(env: NodeJS.ProcessEnv, credentials: CloudCredentials): void {
  writeJson(credentialsPath(env), credentialsSchema.parse(credentials), 0o600);
}

export function readLink(repoRoot: string): CloudLink | undefined {
  return readJson(linkPath(repoRoot), linkSchema);
}

export function writeLink(repoRoot: string, link: CloudLink): void {
  writeJson(linkPath(repoRoot), linkSchema.parse(link));
}

/** Returns whether a link was there to remove. */
export function removeLink(repoRoot: string): boolean {
  const path = linkPath(repoRoot);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Returns whether there were credentials to remove. */
export function removeCredentials(env: NodeJS.ProcessEnv): boolean {
  const path = credentialsPath(env);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
