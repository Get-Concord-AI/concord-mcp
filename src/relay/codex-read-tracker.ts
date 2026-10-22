import { renderedMessageIds } from '../domain/pull-inbox.js';
import type { CodexItem, CodexNotification } from './codex-notifications.js';

/**
 * Read receipts for Concord messages pushed into a Codex thread.
 *
 * Accepting `turn/start` or `turn/steer` only means Codex took the input.
 * A message counts as read once Codex recorded it as a user-message item in
 * the thread, identified by `clientId` (Concord sends its message id as
 * `clientUserMessageId`) or by the `[concord from … id=…]` header in the item
 * text, and then either:
 *   1. the model started an item of its own in that turn after it (a reply,
 *      reasoning, or a tool call): the model was sampled with the message in
 *      its input, as with a Claude transcript entry following the header; or
 *   2. the turn completed with status `completed`.
 * An interrupted or failed turn with no model output after the message proves
 * nothing either way, so the message stays delivered rather than guessed at.
 *
 * Notifications can arrive before the RPC that caused them returns, so
 * evidence is collected for any message Concord has pushed, keyed by turn,
 * whichever order things happen in.
 */

/** Items only the model produces: one starting means it was sampled with the turn's input so far. */
const MODEL_ITEM_TYPES = new Set([
  'agentMessage',
  'reasoning',
  'plan',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'webSearch',
]);

export type CodexReadEvidence = 'model_output' | 'turn_completed';

export class CodexReadTracker {
  /** Message ids pushed into this thread and not yet read. */
  private readonly pushed = new Set<string>();
  /** turn id → messages recorded as input to that turn. */
  private readonly recorded = new Map<string, Set<string>>();
  /** Turns that already completed, in case their input item is reported late. */
  private readonly completed = new Set<string>();

  constructor(
    private readonly threadId: string,
    private readonly onRead: (messageIds: string[], evidence: CodexReadEvidence) => void,
  ) {}

  /** Call before sending `turn/start` or `turn/steer` for `messageId`. */
  expect(messageId: string): void {
    this.pushed.add(messageId);
  }

  /** Feed every app-server notification through here. */
  notify(notification: CodexNotification): void {
    if (!this.sameThread(notification.threadId)) return;
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      if (notification.turnId !== undefined) {
        this.onItem(notification.method, notification.turnId, notification.item);
      }
      return;
    }
    if (notification.method === 'turn/completed') {
      this.onTurnCompleted(notification.turn.id, notification.turn.status);
    }
  }

  private onItem(method: 'item/started' | 'item/completed', turnId: string, item: CodexItem): void {
    if (item.type !== 'userMessage') {
      // Only an item the model starts after the message counts: one already
      // under way when a steer landed was sampled without it.
      if (method === 'item/started' && MODEL_ITEM_TYPES.has(item.type)) {
        this.settle(turnId, 'model_output');
      }
      return;
    }
    const ids = new Set(renderedMessageIds(item.text));
    if (item.clientId !== null) ids.add(item.clientId);
    const ours = [...ids].filter((id) => this.pushed.has(id));
    if (ours.length === 0) return;
    const forTurn = this.recorded.get(turnId) ?? new Set<string>();
    for (const id of ours) forTurn.add(id);
    this.recorded.set(turnId, forTurn);
    if (this.completed.has(turnId)) this.settle(turnId, 'turn_completed');
  }

  private onTurnCompleted(id: string, status: string | undefined): void {
    if (status !== 'completed') {
      // Not proof of reading, and not proof of the opposite: forget the turn.
      this.recorded.delete(id);
      return;
    }
    this.completed.add(id);
    this.settle(id, 'turn_completed');
  }

  private settle(turnId: string, evidence: CodexReadEvidence): void {
    const ids = [...(this.recorded.get(turnId) ?? [])];
    this.recorded.delete(turnId);
    if (ids.length === 0) return;
    for (const id of ids) this.pushed.delete(id);
    this.onRead(ids, evidence);
  }

  private sameThread(threadId: string | undefined): boolean {
    return threadId === undefined || threadId === this.threadId;
  }
}
