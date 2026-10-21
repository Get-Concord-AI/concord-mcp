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
 * same cooperative model every write uses there. Without any viewer, message
 * content is withheld.
 *
 * Reading is a side effect here on purpose: when the recipient itself is
 * handed a message's content in a tool result, its model has that message in
 * its input, which is exactly what `read` means. A sender inspecting its own
 * outbox changes nothing.
 */

export type MessageView = AgentMessageRecord & { receipt: Receipt; redacted?: true };

const WITHHELD = '[withheld: only the sender and recipient can read this message]';

function view(message: AgentMessageRecord): MessageView {
  return { ...message, receipt: toReceipt(message) };
}

function redacted(message: AgentMessageRecord): MessageView {
  return { ...message, content: WITHHELD, receipt: toReceipt(message), redacted: true };
}

function participates(message: AgentMessageRecord, viewer: string): boolean {
  return message.senderAgentId === viewer || message.recipientAgentId === viewer;
}

/** Mark read what `viewer` received among `messages`, returning them refreshed. */
function readOnInspect(
  repos: Repositories,
  viewer: string,
  messages: readonly AgentMessageRecord[],
): AgentMessageRecord[] {
  const received = messages
    .filter((message) => message.recipientAgentId === viewer)
    .map((message) => message.messageId);
  if (received.length === 0) return [...messages];
  const changed = new Map(
    repos.agentMessages
      .markReadByInspect(viewer, received)
      .map((message) => [message.messageId, message]),
  );
  return messages.map((message) => changed.get(message.messageId) ?? message);
}

export type AgentInboxView = Omit<AgentCommunicationView, 'inbox' | 'outbox'> & {
  inbox: MessageView[];
  outbox: MessageView[];
  /** True when the viewer is another agent: presence only, no messages. */
  private: boolean;
};

export function inspectAgentInbox(
  repos: Repositories,
  agentId: string,
  viewer: string | undefined,
): AgentInboxView {
  const communication = inspectAgentCommunication(repos, agentId);
  if ((viewer ?? agentId) !== agentId) {
    return { ...communication, inbox: [], outbox: [], private: true };
  }
  return {
    ...communication,
    inbox: readOnInspect(repos, agentId, communication.inbox).map(view),
    outbox: communication.outbox.map(view),
    private: false,
  };
}

export interface ThreadView {
  thread: MessageView[];
  events: AgentMessageEventRecord[];
}

/** The parts of a thread `viewer` took part in; anything else does not exist for it. */
export function inspectThread(
  repos: Repositories,
  messageId: string,
  viewer: string | undefined,
): ThreadView {
  const notFound = new Error(`Agent message ${messageId} does not exist.`);
  if (repos.agentMessages.get(messageId) === undefined) throw notFound;
  const thread = repos.agentMessages.listThread(messageId);
  if (viewer === undefined) {
    return { thread: thread.map(redacted), events: [] };
  }
  const visible = thread.filter((message) => participates(message, viewer));
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
  viewer: string | undefined,
): MessageView[] {
  if (viewer === undefined) return messages.map(redacted);
  return readOnInspect(
    repos,
    viewer,
    messages.filter((message) => participates(message, viewer)),
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
