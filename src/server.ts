import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories } from './db/index.js';
import { registerClaimWork } from './tools/claim-work.js';
import { registerGetTaskContext } from './tools/get-task-context.js';
import { registerWorkState } from './tools/get-work-state.js';
import { registerHandoff } from './tools/handoff.js';
import { registerUpdateTask } from './tools/update-task.js';
import { VERSION } from './version.js';

/** Concord's advertised MCP server version. */
export const SERVER_VERSION = VERSION;

export interface ServerOptions {
  /** Called after any tool writes to the database (used to regenerate artifacts). */
  onToolWrite?: () => void;
}

/**
 * Build the Concord MCP server and register the v0 tools against the given
 * repositories. Transport wiring lives in the entry points.
 */
export function createServer(repos: Repositories, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'concord-mcp', version: SERVER_VERSION });
  // Register the read surface first so we get the change-notifier, then run it
  // (plus the caller's hook) after every write.
  const notifyWorkStateChanged = registerWorkState(server, repos);
  const onWrite = (): void => {
    options.onToolWrite?.();
    notifyWorkStateChanged();
  };
  registerGetTaskContext(server, repos);
  registerClaimWork(server, repos, onWrite);
  registerUpdateTask(server, repos, onWrite);
  registerHandoff(server, repos, onWrite);
  return server;
}
