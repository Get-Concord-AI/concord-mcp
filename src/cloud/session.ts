import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

import type { AgentIdentity, OpenCodeRequestIdentityMetadata } from '../domain/identity.js';
import { assertKeySafeUrl } from './client.js';
import { bearerFor, type Bearer } from './tokens.js';
import { cloudTargetFor, linkedMachine } from './target.js';

/**
 * The Concord Cloud session of a linked workspace, and the path rule its calls
 * share. Kept apart from `proxy.ts` so that hooks, which only need to know
 * whether the workspace is linked, do not load the MCP SDK on every call.
 */

export interface CloudSession {
  readonly apiUrl: string;
  /** A current bearer token, refreshed as needed; see `cloud/tokens.ts`. */
  readonly bearer: Bearer;
  readonly machineKey: string;
  readonly projectKey: string;
  /** The primary checkout, which holds the link. */
  readonly repoRoot: string;
  /** The checkout this session works in: a linked worktree's own root. */
  readonly checkoutRoot: string;
  readonly identity: AgentIdentity | undefined;
  /** Resolves harness session identity supplied only on MCP requests. */
  readonly requestIdentity?: (
    meta: OpenCodeRequestIdentityMetadata | undefined,
  ) => AgentIdentity | undefined;
}

/**
 * The cloud session for a workspace: undefined on a machine that is not
 * linked, which works locally (see `cloudTargetFor`).
 */
export function cloudSessionFor(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  identity: AgentIdentity | undefined,
  checkoutRoot: string = repoRoot,
  requestIdentity?: (
    meta: OpenCodeRequestIdentityMetadata | undefined,
  ) => AgentIdentity | undefined,
): CloudSession | undefined {
  const machine = linkedMachine(env);
  const target = cloudTargetFor(repoRoot, env);
  if (machine === undefined || target === undefined) return undefined;

  assertKeySafeUrl(target.apiUrl);
  return {
    apiUrl: target.apiUrl,
    bearer: bearerFor(env, target.apiUrl, fetch),
    machineKey: machine.machineKey,
    projectKey: target.projectKey,
    repoRoot,
    checkoutRoot,
    identity,
    ...(requestIdentity === undefined ? {} : { requestIdentity }),
  };
}

/** `path` relative to `root`, or undefined when it is not inside it. */
function inside(root: string, path: string): string | undefined {
  const within = relative(root, path);
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return undefined;
  }
  return within.split(sep).join('/');
}

/**
 * An absolute path inside the checkout this session works in, or the primary
 * one, made relative; anything else as given. Tried as written and resolved,
 * so a path through a symlink (`/tmp` on macOS) still matches.
 */
export function repoRelative(
  session: Pick<CloudSession, 'repoRoot' | 'checkoutRoot'>,
  path: string,
): string {
  if (!isAbsolute(path)) return path;
  const candidates = existsSync(path) ? [path, realpathSync(path)] : [path];
  for (const root of [session.checkoutRoot, session.repoRoot]) {
    for (const candidate of candidates) {
      const within = inside(root, candidate);
      if (within !== undefined) return within;
    }
  }
  return path;
}
