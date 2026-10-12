import { existsSync } from 'node:fs';

import { databasePath } from '../config/paths.js';
import { hasExplicitRepoRoot } from '../workspaces/client-roots.js';
import {
  GENERAL_PROJECT,
  gitOriginRemote,
  isRepository,
  repositoryProjectKey,
  type OriginRemote,
} from '../workspaces/store.js';
import { readCredentials, readLink, readLocalChoice } from './settings.js';

/**
 * Whether a workspace works through Concord Cloud, and as which project.
 *
 * Signed in, the cloud is the default: a repository is its git remote's
 * project, as every clone of it names it, and anywhere outside a repository is
 * `general`, where agents that belong to no repository meet — when the client
 * names that folder (Claude Code's `CLAUDE_PROJECT_DIR`, or `CONCORD_REPO_ROOT`).
 * A server started elsewhere without one may yet learn its repository from MCP
 * roots, so it is not presumed to be outside one.
 *
 * A repository can still choose for itself — `concord cloud link` names its
 * project, `concord cloud unlink` keeps it local — and these stay local too:
 * one already holding local Concord state (its open work must not vanish from
 * view; linking moves it on purpose), and one with no remote, which the cloud
 * has no shared name for.
 */
export interface CloudTarget {
  readonly apiUrl: string;
  readonly projectKey: string;
  /** `link`: the repository's own link; `default`: the signed-in machine's default. */
  readonly source: 'link' | 'default';
}

/** Each repository's remote, asked of git once per process: hooks resolve this on every edit. */
const remotes = new Map<string, string | undefined>();
function cachedOriginRemote(repoRoot: string): string | undefined {
  if (!remotes.has(repoRoot)) remotes.set(repoRoot, gitOriginRemote(repoRoot));
  return remotes.get(repoRoot);
}

export function cloudTargetFor(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  originRemote: OriginRemote = cachedOriginRemote,
): CloudTarget | undefined {
  const link = readLink(repoRoot);
  if (link !== undefined) return { ...link, source: 'link' };
  if (readLocalChoice(repoRoot) || existsSync(databasePath(repoRoot))) return undefined;

  const credentials = readCredentials(env);
  if (credentials === undefined) return undefined;

  const projectKey = isRepository(repoRoot)
    ? repositoryProjectKey(repoRoot, originRemote)
    : hasExplicitRepoRoot(env)
      ? GENERAL_PROJECT
      : undefined;
  return projectKey === undefined
    ? undefined
    : { apiUrl: credentials.apiUrl, projectKey, source: 'default' };
}
