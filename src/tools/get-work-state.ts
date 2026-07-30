import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { buildStatus, type StatusView } from '../artifacts/work-state-view.js';
import type { Repositories } from '../db/index.js';
import {
  selectToolWorkspace,
  type SelectWorkspace,
  workspaceStructured,
} from './workspace-routing.js';

/** Stable URI for the read-only work-state resource. */
export const WORK_STATE_URI = 'concord://work-state';

/**
 * Read the current shared work-state. Pure read: no writes, no artifact
 * regeneration. Overlaps are recomputed live across all active tasks, so this
 * reflects claims made after any single agent's own `start_work` returned.
 */
export function handleGetWorkState(repos: Repositories): StatusView {
  return buildStatus(repos);
}

/**
 * Register the read-only `concord://work-state` resource. The public
 * `inspect_work` workflow tool returns the same workspace snapshot.
 *
 * Returns a `notifyChanged` callback: call it after any write so subscribed
 * clients are pushed a `resources/updated` for `concord://work-state`. MCP
 * cannot wake an idle client — this is push while a session is connected.
 */
export function registerWorkStateResource(
  server: McpServer,
  repos: Repositories,
  selectWorkspace?: SelectWorkspace,
): () => void {
  server.registerResource(
    'work-state',
    WORK_STATE_URI,
    {
      title: 'Concord work state',
      description: 'Active claims, live overlaps, and review-ready tasks as JSON.',
      mimeType: 'application/json',
    },
    (uri) => {
      const workspace = selectToolWorkspace(selectWorkspace, undefined);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: `${JSON.stringify(
              { ...workspaceStructured(workspace), ...handleGetWorkState(repos) },
              null,
              2,
            )}\n`,
          },
        ],
      };
    },
  );

  // Advertise resource subscriptions and track which URIs clients care about,
  // so writes push a targeted `resources/updated` rather than a broadcast.
  server.server.registerCapabilities({ resources: { subscribe: true } });
  const subscribers = new Set<string>();
  server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
    subscribers.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    subscribers.delete(request.params.uri);
    return {};
  });

  return () => {
    if (subscribers.has(WORK_STATE_URI)) {
      void server.server.sendResourceUpdated({ uri: WORK_STATE_URI });
    }
  };
}
