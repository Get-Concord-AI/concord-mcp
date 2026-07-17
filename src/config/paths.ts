import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Directory name that holds all Concord state within a repo. */
export const CONCORD_DIR = '.concord';

/** Filename of the SQLite source-of-truth database. */
export const DB_FILENAME = 'concord.db';

/**
 * Walk upward from `startDir` looking for a `.git` directory and return the
 * repository root. Falls back to `startDir` when no `.git` is found so Concord
 * still works outside a git repo.
 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(startDir);
    }
    dir = parent;
  }
}

/** Absolute path to the `.concord/` directory for a given repo root. */
export function concordDir(repoRoot: string): string {
  return join(repoRoot, CONCORD_DIR);
}

/** Absolute path to the SQLite database for a given repo root. */
export function databasePath(repoRoot: string): string {
  return join(concordDir(repoRoot), DB_FILENAME);
}
