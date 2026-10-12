import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeProjectKey } from '../domain/project-key.js';
import { hasExplicitRepoRoot } from '../workspaces/client-roots.js';
import { GENERAL_PROJECT, gitOriginRemote, type OriginRemote } from '../workspaces/store.js';
import { readCredentials, readLink, readLocalChoice } from './settings.js';

/**
 * Whether a workspace works through Concord Cloud, and as which project.
 *
 * Signed in, the cloud is the default: a repository is its git remote's
 * project, as every clone of it names it, and anywhere outside a repository is
 * `general`, where agents that belong to no repository meet — when the client
 * names that folder (Claude Code's `CLAUDE_PROJECT_DIR`, or `CONCORD_REPO_ROOT`).
 * A server started elsewhere without one may yet learn its repository from MCP
 * roots, so it is not presumed to be outside one. A repository can
 * still choose for itself — `concord cloud link` names its project, `concord
 * cloud unlink` keeps it local. A repository with no remote stays local: the
 * cloud has no name for it that another clone would share.
 */
export interface CloudTarget {
  readonly apiUrl: string;
  readonly projectKey: string;
  /** `link`: the repository's own link; `default`: the signed-in machine's default. */
  readonly source: 'link' | 'default';
}

export function cloudTargetFor(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  originRemote: OriginRemote = gitOriginRemote,
): CloudTarget | undefined {
  const link = readLink(repoRoot);
  if (link !== undefined) return { ...link, source: 'link' };
  if (readLocalChoice(repoRoot)) return undefined;

  const credentials = readCredentials(env);
  if (credentials === undefined) return undefined;

  const projectKey = defaultProjectKey(repoRoot, env, originRemote);
  return projectKey === undefined
    ? undefined
    : { apiUrl: credentials.apiUrl, projectKey, source: 'default' };
}

/** A repository's remote as a project, `general` in a named folder outside one, or none. */
function defaultProjectKey(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  originRemote: OriginRemote,
): string | undefined {
  if (!existsSync(join(repoRoot, '.git'))) {
    return hasExplicitRepoRoot(env) ? GENERAL_PROJECT : undefined;
  }
  const remote = originRemote(repoRoot);
  return (remote === undefined ? null : normalizeProjectKey(remote)) ?? undefined;
}
