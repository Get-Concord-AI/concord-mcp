import { renderPeerMessage, type PeerMessage } from '../domain/pull-inbox.js';
import type { WorkspaceIdentity } from '../workspaces/manager.js';
import { outboxReceiptLines } from './inspect-messages.js';
import type { InspectWorkResult } from './inspect-work.js';
import { searchText } from './search-work.js';
import { withWorkspaceText, workspaceStructured } from './workspace-routing.js';

function messageText(messages: readonly PeerMessage[]): string {
  return messages.map((message) => `\n\n${renderPeerMessage(message)}`).join('');
}

/** Render the visible messages in text too, so a text-only client can read and reply. */
export function inspectWorkResponse(
  result: InspectWorkResult,
  workspace: WorkspaceIdentity | undefined,
) {
  if (result.scope === 'workspace') {
    return {
      content: [
        {
          type: 'text' as const,
          text: withWorkspaceText(
            `${String(result.state.active.length)} active task(s), ` +
              `${String(result.state.overlaps.length)} overlap(s), ` +
              `${String(result.state.presence.length)} registered agent(s).`,
            workspace,
          ),
        },
      ],
      structuredContent: {
        ...workspaceStructured(workspace),
        scope: result.scope,
        presence: result.state.presence,
        active: result.state.active,
        overlaps: result.state.overlaps,
        stale_claims: result.state.staleClaims,
        review_ready: result.state.reviewReady,
        open_questions: result.state.openQuestions,
        communications: result.state.communications,
      },
    };
  }
  if (result.scope === 'agent') {
    return {
      content: [
        {
          type: 'text' as const,
          text: withWorkspaceText(
            `${result.communication.agentId}; promptable ${String(result.communication.promptable)}, ` +
              (result.communication.private
                ? result.communication.messages
                : `${String(result.communication.inbox.length)} inbox message(s), ` +
                  `${String(result.communication.outbox.length)} outbox message(s)` +
                  outboxReceiptLines(result.communication.outbox)) +
              (result.communication.awaitingUserSince === null
                ? '.'
                : `; waiting on its user since ${result.communication.awaitingUserSince}.`) +
              (result.communication.private ? '' : messageText(result.communication.inbox)),
            workspace,
          ),
        },
      ],
      structuredContent: {
        ...workspaceStructured(workspace),
        scope: result.scope,
        ...result.communication,
      },
    };
  }
  if (result.scope === 'search') {
    return {
      content: [{ type: 'text' as const, text: withWorkspaceText(searchText(result), workspace) }],
      structuredContent: {
        ...workspaceStructured(workspace),
        scope: result.scope,
        query: result.query,
        results: result.results,
      },
    };
  }
  if (result.scope === 'message') {
    return {
      content: [
        {
          type: 'text' as const,
          text: withWorkspaceText(
            `${String(result.thread.length)} message(s) in thread.` + messageText(result.thread),
            workspace,
          ),
        },
      ],
      structuredContent: {
        ...workspaceStructured(workspace),
        scope: result.scope,
        thread: result.thread,
        events: result.events,
      },
    };
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: withWorkspaceText(
          `${result.context.task.taskId}; status ${result.context.task.status}, ` +
            `version ${String(result.context.task.version)}, ` +
            `${String(result.context.updates.length)} update(s).` +
            messageText(result.context.messages),
          workspace,
        ),
      },
    ],
    structuredContent: {
      ...workspaceStructured(workspace),
      scope: result.scope,
      task: result.context.task,
      owner_liveness: result.context.ownerLiveness,
      updates: result.context.updates,
      latest_handoff: result.context.latestHandoff ?? null,
      latest_review: result.context.latestReview ?? null,
      pending_handoff: result.context.pendingHandoff ?? null,
      ownership_history: result.context.ownershipHistory,
      overlaps: result.context.overlaps,
      messages: result.context.messages,
    },
  };
}
