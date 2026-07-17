import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories } from './db/index.js';
import { registerClaimWork } from './tools/claim-work.js';
import { registerHandoff } from './tools/handoff.js';
import { registerReviewReady } from './tools/review-ready.js';
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
  registerClaimWork(server, repos, options.onToolWrite);
  registerHandoff(server, repos, options.onToolWrite);
  registerReviewReady(server, repos, options.onToolWrite);
  return server;
}
