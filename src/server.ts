import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories } from './db/index.js';
import { registerClaimWork } from './tools/claim-work.js';
import { registerGetTaskContext } from './tools/get-task-context.js';
import { registerWorkState } from './tools/get-work-state.js';
import { registerHandoff } from './tools/handoff.js';
import { registerHandoffLifecycle } from './tools/handoff-lifecycle.js';
import { registerJoinWorkspace } from './tools/join-workspace.js';
import { registerRegisterAgent } from './tools/register-agent.js';
import { registerUpdateTask } from './tools/update-task.js';
import { registerTaskLifecycle } from './tools/task-lifecycle.js';
import { VERSION } from './version.js';
import {
  routedRepositories,
  type WorkspaceContext,
  type WorkspaceManager,
} from './workspaces/manager.js';

/** Concord's advertised MCP server version. */
export const SERVER_VERSION = VERSION;

export interface ServerOptions {
  /** Called after any tool writes to the database (used to regenerate artifacts). */
  onToolWrite?: (workspace: WorkspaceContext | undefined) => void;
  /** Enables dynamic workspace joins and per-operation workspace selection. */
  workspaceManager?: WorkspaceManager;
}

/**
 * Build the Concord MCP server and register the v0 tools against the given
 * repositories. Transport wiring lives in the entry points.
 */
export function createServer(repos: Repositories, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'concord-mcp', version: SERVER_VERSION });
  const manager = options.workspaceManager;
  const selectedRepos = manager === undefined ? repos : routedRepositories(manager);
  const selectWorkspace =
    manager === undefined ? undefined : (workspaceId?: string) => manager.select(workspaceId);
  // Register the read surface first so we get the change-notifier, then run it
  // (plus the caller's hook) after every write.
  const notifyWorkStateChanged = registerWorkState(server, selectedRepos, selectWorkspace);
  const onWrite = (): void => {
    options.onToolWrite?.(manager?.current());
    notifyWorkStateChanged();
  };
  if (manager !== undefined) {
    registerJoinWorkspace(server, manager, notifyWorkStateChanged);
  }
  registerGetTaskContext(server, selectedRepos, selectWorkspace);
  registerRegisterAgent(server, selectedRepos, onWrite, selectWorkspace);
  registerClaimWork(server, selectedRepos, onWrite, selectWorkspace);
  registerUpdateTask(server, selectedRepos, onWrite, selectWorkspace);
  registerHandoff(server, selectedRepos, onWrite, selectWorkspace);
  registerTaskLifecycle(server, selectedRepos, onWrite, selectWorkspace);
  registerHandoffLifecycle(server, selectedRepos, onWrite, selectWorkspace);
  return server;
}
