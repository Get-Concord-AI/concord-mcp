import { fileURLToPath } from 'node:url';

import { resolveExplicitRepoRoot } from '../config/paths.js';
import type { WorkspaceManager, WorkspaceSelection } from './manager.js';

/** The part of an MCP server connection that can ask the client for its roots. */
export interface RootsClient {
  getClientCapabilities(): { roots?: object | undefined } | undefined;
  listRoots(): Promise<{ roots: readonly { uri: string }[] }>;
}

/**
 * Whether the environment already names the repository. A client that does
 * (Claude Code's `CLAUDE_PROJECT_DIR`, or a project registration's pinned
 * `CONCORD_REPO_ROOT`) is not second-guessed.
 */
export function hasExplicitRepoRoot(env: NodeJS.ProcessEnv): boolean {
  return ['CONCORD_REPO_ROOT', 'CLAUDE_PROJECT_DIR'].some(
    (name) => (env[name]?.trim() ?? '') !== '',
  );
}

export interface ClientRootOptions {
  /** Whether a repository works through Concord Cloud (linked, or by default), which a local server cannot serve. */
  readonly isCloudLinked?: (repoRoot: string) => boolean;
}

/**
 * Join the folder the client has open. A server registered at user scope runs
 * wherever the client launched it (Cursor's global servers, notably), which
 * says nothing about the project in the window; a client that supports MCP
 * roots names that folder. Returns undefined when nothing was joined: the
 * client names no folder, or a tool call chose a workspace while the answer
 * was on its way, which stands. A folder linked to Concord Cloud is refused
 * rather than served from a local store its cloud peers would never see.
 */
export async function joinClientRoot(
  client: RootsClient,
  manager: WorkspaceManager,
  options: ClientRootOptions = {},
): Promise<WorkspaceSelection | undefined> {
  if (client.getClientCapabilities()?.roots === undefined) return undefined;
  const before = manager.selections;
  const { roots } = await client.listRoots();
  if (manager.selections !== before) return undefined;
  const folder = roots.find((root) => root.uri.startsWith('file://'));
  if (folder === undefined) return undefined;
  const root = resolveExplicitRepoRoot(fileURLToPath(folder.uri));
  if (options.isCloudLinked?.(root) === true) {
    manager.refuse(
      `${root} works through Concord Cloud, which this user-level Concord server does not ` +
        "serve. Use the project's own Concord server, which `concord setup` registers, or " +
        '`concord cloud unlink` there to keep it local.',
    );
    return undefined;
  }
  return manager.join(root);
}
