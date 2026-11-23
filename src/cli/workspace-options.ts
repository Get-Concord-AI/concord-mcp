import { resolve } from 'node:path';

import { z } from 'zod';

import {
  findCheckoutRoot,
  resolveExplicitRepoRoot,
  workspaceIdForRoot,
  workspaceRootFromId,
} from '../config/paths.js';
import type { WorkspaceIdentity } from '../workspaces/manager.js';

const cliWorkspaceOptionsSchema = z.object({
  repo: z.string().optional(),
  workspace: z.string().optional(),
});

export type CliWorkspaceOptions = z.infer<typeof cliWorkspaceOptionsSchema>;

export function parseCliWorkspaceOptions(input: unknown): CliWorkspaceOptions {
  return cliWorkspaceOptionsSchema.parse(input);
}

/**
 * Validate a CLI workspace selector and apply it through the same environment
 * override consumed by every CLI context. Returns undefined when no explicit
 * selector was supplied.
 */
export function configureCliWorkspace(
  options: CliWorkspaceOptions,
  cwd: string,
  env: NodeJS.ProcessEnv,
): WorkspaceIdentity | undefined {
  if (options.repo !== undefined && options.workspace !== undefined) {
    throw new Error('Use either --repo or --workspace, not both.');
  }
  if (options.repo === undefined && options.workspace === undefined) {
    return undefined;
  }

  let repoRoot: string;
  if (options.repo !== undefined) {
    const path = resolve(cwd, options.repo);
    repoRoot = resolveExplicitRepoRoot(path);
    env['CONCORD_REPO_ROOT'] = findCheckoutRoot(path);
  } else if (options.workspace !== undefined) {
    repoRoot = workspaceRootFromId(options.workspace);
    env['CONCORD_REPO_ROOT'] = repoRoot;
  } else {
    throw new Error('Concord workspace selection is missing.');
  }
  return { workspaceId: workspaceIdForRoot(repoRoot), repoRoot };
}
