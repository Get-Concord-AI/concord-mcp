import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { buildStatus, renderStatusText, type StatusView } from '../artifacts/work-state-view.js';
import type { Repositories } from '../db/index.js';

/** Stable URI for the read-only work-state resource. */
export const WORK_STATE_URI = 'concord://work-state';

/**
 * Read the current shared work-state. Pure read: no writes, no artifact
 * regeneration. Overlaps are recomputed live across all active tasks, so this
 * reflects claims made after any single agent's own `claim_work` returned.
 */
export function handleGetWorkState(repos: Repositories): StatusView {
  return buildStatus(repos);
}

/**
 * Register the read surface for shared work-state: the `get_work_state` tool
 * (which agents can call directly) and the `concord://work-state` resource (the
 * MCP-native read). Both return the same snapshot. This is read-only and does
 * not change the three-tool *write* surface.
 *
 * Returns a `notifyChanged` callback: call it after any write so subscribed
 * clients are pushed a `resources/updated` for `concord://work-state`. MCP
 * cannot wake an idle client — this is push while a session is connected.
 */
export function registerWorkState(server: McpServer, repos: Repositories): () => void {
  server.registerTool(
    'get_work_state',
    {
      title: 'Get work state',
      description:
        'Read the current shared work-state: who is present (the agent roster with liveness), ' +
        'active claims, overlaps (recomputed live across all active tasks), and review-ready ' +
        'tasks. Read-only — call this before claiming to see who else is here and what they are ' +
        'already working on.',
    },
    () => {
      const view = handleGetWorkState(repos);
      return {
        content: [{ type: 'text', text: renderStatusText(view) }],
        structuredContent: {
          presence: view.presence,
          active: view.active,
          overlaps: view.overlaps,
          review_ready: view.reviewReady,
          open_questions: view.openQuestions,
        },
      };
    },
  );

  server.registerResource(
    'work-state',
    WORK_STATE_URI,
    {
      title: 'Concord work state',
      description: 'Active claims, live overlaps, and review-ready tasks as JSON.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: `${JSON.stringify(handleGetWorkState(repos), null, 2)}\n`,
        },
      ],
    }),
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
