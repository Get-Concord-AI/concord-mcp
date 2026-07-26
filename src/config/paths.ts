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

/**
 * Resolve the repo root for the MCP server, whose own `process.cwd()` is
 * unreliable: when the server is registered at user scope it is launched from
 * wherever the client started, not the repo the agent is editing — so a claim
 * lands in one store while reads hit an empty repo-local `.concord/`. Prefer, in
 * order, an explicit `CONCORD_REPO_ROOT`, Claude Code's `CLAUDE_PROJECT_DIR`
 * (set in the server's env to the project root regardless of scope), then the
 * cwd. Each candidate is normalized through `findRepoRoot`, so the store always
 * lands at the `.concord/` in the root of the repo.
 */
export function resolveRepoRoot(cwd: string, env: NodeJS.ProcessEnv): string {
  const override = env['CONCORD_REPO_ROOT'];
  if (override !== undefined && override.trim() !== '') {
    return findRepoRoot(override);
  }
  const projectDir = env['CLAUDE_PROJECT_DIR'];
  if (projectDir !== undefined && projectDir.trim() !== '') {
    return findRepoRoot(projectDir);
  }
  return findRepoRoot(cwd);
}

/** Absolute path to the `.concord/` directory for a given repo root. */
export function concordDir(repoRoot: string): string {
  return join(repoRoot, CONCORD_DIR);
}

/** Absolute path to the SQLite database for a given repo root. */
export function databasePath(repoRoot: string): string {
  return join(concordDir(repoRoot), DB_FILENAME);
}
