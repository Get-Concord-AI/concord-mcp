import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HarnessName } from '../../domain/harness-config.js';
import { upgradeStablePath } from '../../config/install-mode.js';
import { userHome } from '../../config/paths.js';
import { claudeSkillsPluginPath } from '../claude-plugin.js';

/**
 * How an adapter link looks on disk. `foreign` is a working link to a Concord
 * copy other than the one running; `dangling` points at something deleted;
 * `occupied` is a path Concord does not own.
 */
export type LinkHealth = 'linked' | 'foreign' | 'dangling' | 'missing' | 'occupied';

export interface LinkCheck {
  target: string;
  health: LinkHealth;
  pointsTo?: string | undefined;
  expected?: string | undefined;
}

export interface LinkRepair {
  harness: HarnessName;
  target: string;
  from: string | undefined;
  to: string;
}

export type EphemeralTest = (path: string) => boolean;

/** Harnesses whose adapter is a link to a directory shipped in this package. */
const LINKED_ADAPTERS = {
  'claude-code': ['plugin', 'concord-relay'],
  gemini: ['plugin', 'gemini', 'concord-relay'],
  cursor: ['plugin', 'cursor', 'concord-relay'],
} as const satisfies Partial<Record<HarnessName, readonly string[]>>;

export type LinkedHarness = keyof typeof LINKED_ADAPTERS;

const LINKED_HARNESSES: readonly LinkedHarness[] = ['claude-code', 'gemini', 'cursor'];

const EPHEMERAL_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

export function geminiTarget(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.gemini', 'extensions', 'concord-relay');
}

export function cursorTarget(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.cursor', 'extensions', 'get-concord-ai.concord-relay');
}

export function linkTarget(harness: LinkedHarness, env: NodeJS.ProcessEnv): string {
  if (harness === 'claude-code') return claudeSkillsPluginPath(env);
  return harness === 'gemini' ? geminiTarget(env) : cursorTarget(env);
}

/** The directory this package ships for a harness, found by walking up from the caller. */
export function packagedAdapter(moduleUrl: string, harness: LinkedHarness): string | undefined {
  return packagedPath(moduleUrl, LINKED_ADAPTERS[harness]);
}

export function packagedPath(moduleUrl: string, parts: readonly string[]): string | undefined {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 7; depth += 1) {
    const candidate = join(directory, ...parts);
    if (existsSync(candidate)) return upgradeStablePath(candidate);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * A checkout that will be cleaned up: a temp directory or npm's npx cache. A
 * global link into one dangles as soon as it is removed.
 */
export function isEphemeralPath(path: string): boolean {
  const temp = tmpdir();
  const roots = [...EPHEMERAL_ROOTS, temp, realpathOr(temp)];
  // The written path still matters once a dangling destination stops resolving.
  return [path, realpathOr(path)].some(
    (candidate) =>
      candidate.split(sep).includes('_npx') ||
      roots.some((root) => candidate === root || candidate.startsWith(`${root}${sep}`)),
  );
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function hasConcordManifest(path: string): boolean {
  const manifests = [
    join(path, '.claude-plugin', 'plugin.json'),
    join(path, 'gemini-extension.json'),
    join(path, 'package.json'),
  ];
  return manifests.some((manifest) => {
    try {
      return readFileSync(manifest, 'utf8').includes('concord-relay');
    } catch {
      return false;
    }
  });
}

/** Inspect an adapter link against the copy this package would install. */
export function inspectLink(target: string, expected: string | undefined): LinkCheck {
  if (!isSymlink(target)) {
    if (!existsSync(target)) return { target, health: 'missing', expected };
    return { target, health: hasConcordManifest(target) ? 'linked' : 'occupied', expected };
  }
  const pointsTo = resolve(dirname(target), readlinkSync(target));
  const check = { target, pointsTo, expected };
  if (!existsSync(target)) return { ...check, health: 'dangling' };
  if (!hasConcordManifest(target)) return { ...check, health: 'occupied' };
  const elsewhere = expected !== undefined && realpathOr(target) !== realpathOr(expected);
  return { ...check, health: elsewhere ? 'foreign' : 'linked' };
}

/** A link that is broken now, or will be once its throwaway checkout is cleaned up. */
export function linkNeedsRepair(
  check: LinkCheck,
  isEphemeral: EphemeralTest = isEphemeralPath,
): boolean {
  if (check.health === 'dangling') return true;
  const working = check.health === 'linked' || check.health === 'foreign';
  return working && check.pointsTo !== undefined && isEphemeral(check.pointsTo);
}

/**
 * Link `source` at `target`, replacing an older Concord link. A source in a
 * throwaway checkout never displaces a working link to a lasting install,
 * because it would leave that link dangling once the checkout is removed.
 */
export function installLink(
  source: string,
  target: string,
  isEphemeral: EphemeralTest = isEphemeralPath,
): 'installed' | 'occupied' {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target) || isSymlink(target)) {
    if (!isSymlink(target)) return 'occupied';
    if (readlinkSync(target) === source) return 'installed';
    const current = inspectLink(target, source);
    if (
      isEphemeral(source) &&
      current.health === 'foreign' &&
      !linkNeedsRepair(current, isEphemeral)
    ) {
      return 'installed';
    }
    rmSync(target);
  }
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  return 'installed';
}

/** Adapter links that are broken and that this package can re-point. */
export function brokenAdapterLinks(
  moduleUrl: string,
  env: NodeJS.ProcessEnv,
  isEphemeral: EphemeralTest = isEphemeralPath,
): LinkRepair[] {
  return LINKED_HARNESSES.flatMap((harness) => {
    const expected = packagedAdapter(moduleUrl, harness);
    if (expected === undefined || isEphemeral(expected)) return [];
    const check = inspectLink(linkTarget(harness, env), expected);
    if (!linkNeedsRepair(check, isEphemeral)) return [];
    return [{ harness, target: check.target, from: check.pointsTo, to: expected }];
  });
}

/** Re-point every broken adapter link at this package; returns what changed. */
export function repairAdapterLinks(
  moduleUrl: string,
  env: NodeJS.ProcessEnv,
  isEphemeral: EphemeralTest = isEphemeralPath,
): LinkRepair[] {
  const repairs = brokenAdapterLinks(moduleUrl, env, isEphemeral);
  for (const repair of repairs) {
    rmSync(repair.target);
    symlinkSync(repair.to, repair.target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return repairs;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
