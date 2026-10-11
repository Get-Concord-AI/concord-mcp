import { fileURLToPath } from 'node:url';

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

/**
 * Join the folder the client has open. A server registered at user scope runs
 * wherever the client launched it (Cursor's global servers, notably), which
 * says nothing about the project in the window; a client that supports MCP
 * roots names that folder. Returns undefined when the client names none.
 */
export async function joinClientRoot(
  client: RootsClient,
  manager: WorkspaceManager,
): Promise<WorkspaceSelection | undefined> {
  if (client.getClientCapabilities()?.roots === undefined) return undefined;
  const { roots } = await client.listRoots();
  const folder = roots.find((root) => root.uri.startsWith('file://'));
  return folder === undefined ? undefined : manager.join(fileURLToPath(folder.uri));
}
