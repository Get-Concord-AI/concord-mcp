import type { AgentMessageEventRecord, AgentMessageRecord, Repositories } from '../db/index.js';
import { toReceipt, type Receipt } from '../domain/receipts.js';
import { inspectAgentCommunication, type AgentCommunicationView } from './agent-messages.js';

/**
 * Inbox privacy for inspect_work: an agent reads only messages it sent or
 * received. Inspecting another agent shows its presence, never its mail.
 *
 * The viewer is the session's own identity. Where Concord cannot see the
 * session (Codex scrubs its environment), the only id available is the one
 * the caller names, so an agent naming itself is trusted to be itself — the
 * same cooperative model every write uses there. Without any viewer, nothing
 * is shown. This keeps cooperating agents out of each other's mail; it is not
 * a security boundary (anyone with a shell can run `concord messages`).
 *
 * Reading is a side effect, but only for a viewer Concord identified from the
 * session itself: when the recipient's own session is handed a message's
 * content in a tool result, its model has that message in its input, which is
 * exactly what `read` means. A self-named viewer could be anyone, so it never
 * changes a receipt, and neither does a sender inspecting its own outbox.
 */

export interface Viewer {
  agentId: string;
  /** Identified from the session, not merely named by the caller. */
  verified: boolean;
}

export type MessageView = AgentMessageRecord & { receipt: Receipt };

function view(message: AgentMessageRecord): MessageView {
  return { ...message, receipt: toReceipt(message) };
}

function participates(message: AgentMessageRecord, viewer: string): boolean {
  return message.senderAgentId === viewer || message.recipientAgentId === viewer;
}

/** Mark read what a verified `viewer` received among `messages`, returning them refreshed. */
function readOnInspect(
  repos: Repositories,
  viewer: Viewer,
  messages: readonly AgentMessageRecord[],
): AgentMessageRecord[] {
  if (!viewer.verified) return [...messages];
  const received = messages
    .filter((message) => message.recipientAgentId === viewer.agentId)
    .map((message) => message.messageId);
  if (received.length === 0) return [...messages];
  const changed = new Map(
    repos.agentMessages
      .markReadByInspect(viewer.agentId, received)
      .map((message) => [message.messageId, message]),
  );
  return messages.map((message) => changed.get(message.messageId) ?? message);
}

type AgentPresenceView = Omit<AgentCommunicationView, 'inbox' | 'outbox'>;

/**
 * Another agent sees presence only. Its inbox and outbox are left out rather
 * than sent empty, so a caller cannot mistake hidden mail for no mail.
 */
export type AgentInboxView =
  | (AgentPresenceView & { private: true; messages: string })
  | (AgentPresenceView & { private: false; inbox: MessageView[]; outbox: MessageView[] });

export function privateMessagesNote(agentId: string): string {
  return (
    `Messages are private to ${agentId}; Concord does not show one agent another's inbox or outbox. ` +
    'For a message you sent, check its receipt with inspect_work message_id.'
  );
}

export function inspectAgentInbox(
  repos: Repositories,
  agentId: string,
  viewer: Viewer,
): AgentInboxView {
  const { inbox, outbox, ...presence } = inspectAgentCommunication(repos, agentId);
  if (viewer.agentId !== agentId) {
    return { ...presence, private: true, messages: privateMessagesNote(agentId) };
  }
  return {
    ...presence,
    private: false,
    inbox: readOnInspect(repos, viewer, inbox).map(view),
    outbox: outbox.map(view),
  };
}

export interface ThreadView {
  thread: MessageView[];
  events: AgentMessageEventRecord[];
}

/**
 * The parts of a thread `viewer` took part in; anything else does not exist
 * for it, and neither does any of it for a caller Concord cannot identify.
 */
export function inspectThread(
  repos: Repositories,
  messageId: string,
  viewer: Viewer | undefined,
): ThreadView {
  const notFound = new Error(
    `Agent message ${messageId} does not exist` +
      (viewer === undefined ? ', or this caller cannot be identified: pass your agent_id.' : '.'),
  );
  if (viewer === undefined || repos.agentMessages.get(messageId) === undefined) throw notFound;
  const visible = repos.agentMessages
    .listThread(messageId)
    .filter((message) => participates(message, viewer.agentId));
  if (!visible.some((message) => message.messageId === messageId)) throw notFound;
  const shown = readOnInspect(repos, viewer, visible);
  const ids = new Set(shown.map((message) => message.messageId));
  return {
    thread: shown.map(view),
    events: [...ids].flatMap((id) => repos.agentMessages.listEvents(id)),
  };
}

/** A task's messages, reduced to the ones `viewer` sent or received. */
export function visibleTaskMessages(
  repos: Repositories,
  messages: readonly AgentMessageRecord[],
  viewer: Viewer | undefined,
): MessageView[] {
  if (viewer === undefined) return [];
  return readOnInspect(
    repos,
    viewer,
    messages.filter((message) => participates(message, viewer.agentId)),
  ).map(view);
}

/** The newest outbox receipts, one line each, for clients that show only text. */
export function outboxReceiptLines(outbox: readonly MessageView[], limit = 10): string {
  const recent = outbox.slice(-limit);
  if (recent.length === 0) return '';
  return (
    '\nSent:\n' +
    recent
      .map(
        (message) =>
          `- ${message.messageId} to ${message.recipientAgentId}: ${message.receipt.ticks}`,
      )
      .join('\n')
  );
}
