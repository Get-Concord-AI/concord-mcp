import type { AgentMessageRecord } from '../db/index.js';
import { renderPeerMessage } from '../domain/pull-inbox.js';
import { ticksFor } from '../domain/receipts.js';
import type { WorkspaceIdentity } from '../workspaces/manager.js';
import { outboxReceiptLines } from './inspect-messages.js';
import type { InspectWorkResult } from './inspect-work.js';
import { searchText } from './search-work.js';
import { withWorkspaceText, workspaceStructured } from './workspace-routing.js';

function messageText(
  messages: readonly AgentMessageRecord[],
  viewerAgentId: string | undefined,
): string {
  return messages
    .map((message) => {
      const terminalStatus =
        message.status === 'replied' || message.status === 'failed' ? message.status : undefined;
      const block =
        message.senderAgentId === viewerAgentId
          ? `[concord to ${message.recipientAgentId} id=${message.messageId} ${ticksFor(message.status)}]\n${message.content}`
          : renderPeerMessage(message, terminalStatus);
      return `\n\n${block}`;
    })
    .join('');
}

/**
 * Each inspect_work scope returns text for text-only clients and the full view
 * as structured content. The text includes visible message bodies and their IDs
 * so clients can read messages and reply on the original thread.
 */
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
              messageText(result.textInbox, result.communication.agentId),
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
            `${String(result.thread.length)} message(s) in thread.` +
              messageText(result.thread, result.viewerAgentId),
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
            messageText(result.context.messages, result.viewerAgentId),
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
