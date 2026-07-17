import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories } from './db/index.js';
import { registerClaimWork } from './tools/claim-work.js';
import { registerHandoff } from './tools/handoff.js';
import { registerReviewReady } from './tools/review-ready.js';

/** Concord's advertised MCP server version. */
export const SERVER_VERSION = '0.1.0';

/**
 * Build the Concord MCP server and register the v0 tools against the given
 * repositories. Transport wiring lives in the entry points.
 */
export function createServer(repos: Repositories): McpServer {
  const server = new McpServer({ name: 'concord-mcp', version: SERVER_VERSION });
  registerClaimWork(server, repos);
  registerHandoff(server, repos);
  registerReviewReady(server, repos);
  return server;
}
