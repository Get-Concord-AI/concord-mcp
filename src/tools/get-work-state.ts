import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
 */
export function registerWorkState(server: McpServer, repos: Repositories): void {
  server.registerTool(
    'get_work_state',
    {
      title: 'Get work state',
      description:
        'Read the current shared work-state: active claims, overlaps (recomputed live across ' +
        'all active tasks), and review-ready tasks. Read-only — call this before claiming to ' +
        'see what other agents are already working on.',
    },
    () => {
      const view = handleGetWorkState(repos);
      return {
        content: [{ type: 'text', text: renderStatusText(view) }],
        structuredContent: {
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
}
