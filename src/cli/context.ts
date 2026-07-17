import { concordDir, databasePath, findRepoRoot } from '../config/paths.js';
import { openRepositories, type Repositories } from '../db/index.js';

export interface CliContext {
  repoRoot: string;
  concordPath: string;
  repos: Repositories;
}

/** Resolve the repo root from `cwd` and open the Concord workspace there. */
export function openContext(cwd: string): CliContext {
  const repoRoot = findRepoRoot(cwd);
  return {
    repoRoot,
    concordPath: concordDir(repoRoot),
    repos: openRepositories(databasePath(repoRoot)),
  };
}
