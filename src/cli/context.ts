import { linkedMachine } from '../cloud/target.js';
import { resolveRepoRoot, workspaceIdForRoot } from '../config/paths.js';
import { openRepositories, type Repositories } from '../db/index.js';
import { localStore, resolveStore, type StoreLocation } from '../workspaces/store.js';

export interface CliContext {
  workspaceId: string;
  repoRoot: string;
  concordPath: string;
  store: StoreLocation;
  repos: Repositories;
}

export interface OpenContextOptions {
  /** Open the repository's own `.concord/` even when global mode would choose otherwise. */
  readonly local?: boolean;
}

/**
 * Why a command that reads the local store does nothing on a linked machine:
 * its work lives in Concord Cloud.
 */
export const LINKED_MACHINE_MESSAGE =
  'This machine works through Concord Cloud, so there is no local Concord store here. ' +
  'See your workspace at https://app.getconcord.ai, or run `concord cloud unlink` to use ' +
  'local Concord on this machine.';

/**
 * Resolve the repo root with the same priority as MCP and open that workspace.
 *
 * Refused on a machine linked to Concord Cloud. Opening creates the store, and
 * a store created there is a second, local network that no cloud agent can
 * reach, so every caller must take its cloud path first.
 */
export function openContext(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: OpenContextOptions = {},
): CliContext {
  if (linkedMachine(env) !== undefined) throw new Error(LINKED_MACHINE_MESSAGE);
  const repoRoot = resolveRepoRoot(cwd, env);
  const store = options.local === true ? localStore(repoRoot) : resolveStore(repoRoot, env);
  return {
    workspaceId: workspaceIdForRoot(repoRoot),
    repoRoot,
    concordPath: store.concordPath,
    store,
    repos: openRepositories(store.databasePath, store.project),
  };
}
