import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Directory name that holds all Concord state within a repo. */
export const CONCORD_DIR = '.concord';

/** Filename of the SQLite source-of-truth database. */
export const DB_FILENAME = 'concord.db';

/** Prefix for path-backed workspace ids returned by the MCP surface. */
export const WORKSPACE_ID_PREFIX = 'ws_';

function canonicalPath(input: string): string {
  const absolute = resolve(input);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function linkedWorktreePrimaryRoot(checkoutRoot: string): string | undefined {
  const gitEntry = join(checkoutRoot, '.git');
  if (!statSync(gitEntry).isFile()) {
    return undefined;
  }

  const pointer = /^gitdir:\s*(.+)$/iu.exec(readFileSync(gitEntry, 'utf8').trim());
  const gitDirValue = pointer?.[1]?.trim();
  if (gitDirValue === undefined || gitDirValue === '') {
    return undefined;
  }

  const gitDir = resolve(checkoutRoot, gitDirValue);
  const commonDirFile = join(gitDir, 'commondir');
  if (!existsSync(commonDirFile)) {
    return undefined;
  }

  const commonDirValue = readFileSync(commonDirFile, 'utf8').trim();
  if (commonDirValue === '') {
    return undefined;
  }

  const commonDir = resolve(gitDir, commonDirValue);
  if (basename(commonDir) === '.git') {
    return canonicalPath(dirname(commonDir));
  }
  return undefined;
}

/**
 * Walk upward from `startDir` looking for a `.git` entry and return the
 * canonical repository root. Linked worktrees follow their `gitdir` and
 * `commondir` metadata to the primary checkout so every worktree shares one
 * `.concord/` store. Falls back to `startDir` when no `.git` is found so
 * Concord still works outside a git repo.
 */
export function findRepoRoot(startDir: string): string {
  const start = canonicalPath(startDir);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      return linkedWorktreePrimaryRoot(dir) ?? dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
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
    return resolveExplicitRepoRoot(override);
  }
  const projectDir = env['CLAUDE_PROJECT_DIR'];
  if (projectDir !== undefined && projectDir.trim() !== '') {
    return resolveExplicitRepoRoot(projectDir);
  }
  return findRepoRoot(cwd);
}

/**
 * Resolve and validate a root supplied explicitly by a caller. Unlike the
 * backward-compatible cwd fallback, explicit roots must exist and be
 * directories so a typo cannot silently create a new Concord workspace.
 */
export function resolveExplicitRepoRoot(input: string): string {
  if (input.trim() === '') {
    throw new Error('Workspace root must not be blank.');
  }
  const candidate = resolve(input);
  if (!existsSync(candidate)) {
    throw new Error(`Workspace root does not exist: ${candidate}`);
  }
  if (!statSync(candidate).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${candidate}`);
  }
  return findRepoRoot(candidate);
}

/** Return the stable, reversible id for a canonical workspace root. */
export function workspaceIdForRoot(repoRoot: string): string {
  return `${WORKSPACE_ID_PREFIX}${Buffer.from(canonicalPath(repoRoot), 'utf8').toString('base64url')}`;
}

/** Decode and validate a workspace id returned by `workspaceIdForRoot`. */
export function workspaceRootFromId(workspaceId: string): string {
  if (!workspaceId.startsWith(WORKSPACE_ID_PREFIX)) {
    throw new Error(`Invalid workspace id: ${workspaceId}`);
  }
  const encoded = workspaceId.slice(WORKSPACE_ID_PREFIX.length);
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  if (
    encoded === '' ||
    !isAbsolute(decoded) ||
    Buffer.from(decoded, 'utf8').toString('base64url') !== encoded
  ) {
    throw new Error(`Invalid workspace id: ${workspaceId}`);
  }
  return resolveExplicitRepoRoot(decoded);
}

/** Absolute path to the `.concord/` directory for a given repo root. */
export function concordDir(repoRoot: string): string {
  return join(repoRoot, CONCORD_DIR);
}

/** Absolute path to the SQLite database for a given repo root. */
export function databasePath(repoRoot: string): string {
  return join(concordDir(repoRoot), DB_FILENAME);
}
