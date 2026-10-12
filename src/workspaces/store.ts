import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { concordDir, databasePath } from '../config/paths.js';
import { globalDatabasePath, readUserConfig, userConcordDir } from '../config/user-config.js';
import { LOCAL_PROJECT } from '../db/index.js';
import { normalizeProjectKey } from '../domain/project-key.js';

/**
 * The project for work outside any repository, named as Concord Cloud names
 * it (`GENERAL_WORKSPACE`), so instructions mean the same thing against both.
 */
export const GENERAL_PROJECT = 'general';

/** Where a workspace's state lives. */
export interface StoreLocation {
  /** `local`: the repository's own `.concord/`; `global`: the machine-wide store. */
  readonly kind: 'local' | 'global';
  readonly databasePath: string;
  /** Where its human-readable artifacts are written. */
  readonly concordPath: string;
  /** The workspace's project inside the database. */
  readonly project: string;
}

export type OriginRemote = (repoRoot: string) => string | undefined;

/** The repository's `origin` URL as git reports it, if it has one. */
export function gitOriginRemote(repoRoot: string): string | undefined {
  const result = spawnSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  });
  const url = result.status === 0 ? result.stdout.trim() : '';
  return url === '' ? undefined : url;
}

/** The repository's own `.concord/` store, created on first use. */
export function localStore(repoRoot: string): StoreLocation {
  return {
    kind: 'local',
    databasePath: databasePath(repoRoot),
    concordPath: concordDir(repoRoot),
    project: LOCAL_PROJECT,
  };
}

/**
 * A workspace's project in the machine-wide store. A repository is named by
 * its git remote, as Concord Cloud names it, so every clone shares one project;
 * one with no remote by its path. Anything outside a repository is `general`.
 */
export function globalProjectKey(repoRoot: string, originRemote: OriginRemote): string {
  if (!isRepository(repoRoot)) return GENERAL_PROJECT;
  return repositoryProjectKey(repoRoot, originRemote) ?? repoRoot;
}

/** Whether a workspace root is a git repository (or a linked worktree of one). */
export function isRepository(root: string): boolean {
  return existsSync(join(root, '.git'));
}

/**
 * A repository's project as Concord Cloud names it — its normalised `origin`,
 * which every clone shares — or undefined when it has none. Shared by the
 * machine-wide store and the cloud default, so the two never name it apart.
 */
export function repositoryProjectKey(
  repoRoot: string,
  originRemote: OriginRemote,
): string | undefined {
  const remote = originRemote(repoRoot);
  return (remote === undefined ? null : normalizeProjectKey(remote)) ?? undefined;
}

/** Characters of the project key kept in its directory name, well under any name limit. */
const READABLE_NAME_LENGTH = 64;

/** A readable directory name for a project's artifacts, unique by its hash. */
export function artifactDirName(project: string): string {
  const readable = project
    .replace(/[^a-z0-9._-]+/giu, '-')
    .slice(-READABLE_NAME_LENGTH)
    .replace(/^-+|-+$/gu, '');
  const hash = createHash('sha256').update(project).digest('hex').slice(0, 8);
  return `${readable === '' ? 'project' : readable}-${hash}`;
}

/**
 * Choose the store for a workspace root. A repository that was set up keeps
 * everything in its own `.concord/`, messages and roster included. Otherwise,
 * when the user turned on global mode, the workspace is a project in the
 * machine-wide store, so nothing is written into the repository. Without global
 * mode the repository's own store is created, as it always has been.
 */
export function resolveStore(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  originRemote: OriginRemote = gitOriginRemote,
): StoreLocation {
  if (existsSync(databasePath(repoRoot)) || readUserConfig(env).globalMode !== true) {
    return localStore(repoRoot);
  }
  const project = globalProjectKey(repoRoot, originRemote);
  return {
    kind: 'global',
    databasePath: globalDatabasePath(env),
    concordPath: join(userConcordDir(env), 'projects', artifactDirName(project)),
    project,
  };
}
