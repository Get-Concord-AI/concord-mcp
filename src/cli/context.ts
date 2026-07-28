import { concordDir, databasePath, resolveRepoRoot, workspaceIdForRoot } from '../config/paths.js';
import { openRepositories, type Repositories } from '../db/index.js';

export interface CliContext {
  workspaceId: string;
  repoRoot: string;
  concordPath: string;
  repos: Repositories;
}

/** Resolve the repo root with the same priority as MCP and open that workspace. */
export function openContext(cwd: string, env: NodeJS.ProcessEnv = process.env): CliContext {
  const repoRoot = resolveRepoRoot(cwd, env);
  return {
    workspaceId: workspaceIdForRoot(repoRoot),
    repoRoot,
    concordPath: concordDir(repoRoot),
    repos: openRepositories(databasePath(repoRoot)),
  };
}
