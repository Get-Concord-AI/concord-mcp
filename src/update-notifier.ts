import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { updateCommand } from './config/install-mode.js';

const REGISTRY_URL = 'https://registry.npmjs.org/@concord-ai%2fconcord-mcp/latest';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 400;
const BACKGROUND_FETCH_TIMEOUT_MS = 5_000;

const registryResponseSchema = z.object({ version: z.string() });
const updateCacheSchema = z.object({
  checkedAt: z.number(),
  latestVersion: z.string().nullable(),
});

interface VersionParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

interface UpdateCache {
  checkedAt: number;
  latestVersion: string | null;
}

export interface AvailableUpdate {
  currentVersion: string;
  latestVersion: string;
  command: string;
}

export interface BackgroundUpdateCheck {
  getAvailableUpdate: () => AvailableUpdate | undefined;
  done: Promise<void>;
}

type UpdateResolver = (
  currentVersion: string,
  env: NodeJS.ProcessEnv,
) => Promise<AvailableUpdate | undefined>;

export interface UpdateCheckOptions {
  currentVersion: string;
  cacheFile: string;
  now?: number;
  ttlMs?: number;
  fetchLatest?: () => Promise<string | null>;
}

function parseVersion(version: string): VersionParts | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: match?.[4] ?? null,
  };
}

/** SemVer comparison for the stable x.y.z versions published under npm latest. */
export function isNewerVersion(currentVersion: string, latestVersion: string): boolean {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  if (current === undefined || latest === undefined) {
    return false;
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (latest[key] !== current[key]) {
      return latest[key] > current[key];
    }
  }
  return current.prerelease !== null && latest.prerelease === null;
}

function readCache(cacheFile: string): UpdateCache | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
    return updateCacheSchema.parse(raw);
  } catch {
    return undefined;
  }
}

function writeCache(cacheFile: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify(cache)}\n`, 'utf8');
  } catch {
    // A read-only home directory must never make a Concord command fail.
  }
}

async function fetchLatestVersion(timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    const raw: unknown = await response.json();
    return registryResponseSchema.parse(raw).version;
  } catch {
    return null;
  }
}

/**
 * Return the newer published version, if any. Registry results (including a
 * failed best-effort check) are cached so normal commands do not perform
 * network I/O more than once per day.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | undefined> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cached = readCache(options.cacheFile);
  if (cached !== undefined && now - cached.checkedAt >= 0 && now - cached.checkedAt < ttlMs) {
    return cached.latestVersion !== null &&
      isNewerVersion(options.currentVersion, cached.latestVersion)
      ? cached.latestVersion
      : undefined;
  }

  const latestVersion = await (options.fetchLatest ?? fetchLatestVersion)();
  writeCache(options.cacheFile, { checkedAt: now, latestVersion });
  return latestVersion !== null && isNewerVersion(options.currentVersion, latestVersion)
    ? latestVersion
    : undefined;
}

export function updateCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env['XDG_CACHE_HOME'] ??
    (process.platform === 'win32' ? env['LOCALAPPDATA'] : undefined) ??
    join(homedir(), '.cache');
  return join(base, 'concord', 'update-check.json');
}

export function formatUpdateNotice(currentVersion: string, latestVersion: string): string {
  return [
    `Update available: Concord ${currentVersion} → ${latestVersion}`,
    `Run: ${updateCommand()}`,
  ].join('\n');
}

/** Resolve a cached best-effort update for surfaces other than the interactive CLI. */
export async function findAvailableUpdate(
  currentVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchTimeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<AvailableUpdate | undefined> {
  if (env['CI'] !== undefined || env['CONCORD_NO_UPDATE_CHECK'] === '1') {
    return undefined;
  }
  const latestVersion = await checkForUpdate({
    currentVersion,
    cacheFile: updateCacheFile(env),
    fetchLatest: () => fetchLatestVersion(fetchTimeoutMs),
  });
  return latestVersion === undefined
    ? undefined
    : { currentVersion, latestVersion, command: updateCommand() };
}

/** Start a non-blocking check whose result can be read by a later tool call. */
export function startBackgroundUpdateCheck(
  currentVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  resolveUpdate: UpdateResolver = (version, checkEnv) =>
    findAvailableUpdate(version, checkEnv, BACKGROUND_FETCH_TIMEOUT_MS),
): BackgroundUpdateCheck {
  let availableUpdate: AvailableUpdate | undefined;
  const done = resolveUpdate(currentVersion, env).then(
    (update) => {
      availableUpdate = update;
    },
    () => {
      // Update awareness is best-effort and must never affect the host process.
    },
  );
  return {
    getAvailableUpdate: () => availableUpdate,
    done,
  };
}

/** Best-effort interactive notice. Never throws or writes to normal stdout. */
export async function notifyIfUpdateAvailable(
  currentVersion: string,
  stderr: NodeJS.WriteStream = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!stderr.isTTY || env['CI'] !== undefined || env['CONCORD_NO_UPDATE_CHECK'] === '1') {
    return;
  }
  try {
    const update = await findAvailableUpdate(currentVersion, env);
    if (update !== undefined) {
      stderr.write(`${formatUpdateNotice(update.currentVersion, update.latestVersion)}\n\n`);
    }
  } catch {
    // Version awareness is useful, but no update check may break the CLI.
  }
}
