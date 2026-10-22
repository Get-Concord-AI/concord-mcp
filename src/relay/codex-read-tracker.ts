import { z } from 'zod';

import { renderedMessageIds } from '../domain/pull-inbox.js';

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

const userMessageItemSchema = z
  .object({
    type: z.literal('userMessage'),
    clientId: z.string().nullable().optional(),
    content: z.unknown().optional(),
  })
  .loose();
const itemNotificationSchema = z
  .object({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    item: z.unknown(),
  })
  .loose();
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
const modelItemSchema = z.object({ type: z.string() }).loose();
const turnNotificationSchema = z
  .object({
    threadId: z.string().optional(),
    turn: z.object({ id: z.string(), status: z.string().optional() }).loose(),
  })
  .loose();

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
  notify(method: string, params: Record<string, unknown> | undefined): void {
    if (method === 'item/started' || method === 'item/completed') this.onItem(method, params);
    if (method === 'turn/completed') this.onTurnCompleted(params);
  }

  private onItem(method: string, params: Record<string, unknown> | undefined): void {
    const notification = itemNotificationSchema.safeParse(params);
    if (!notification.success || !this.sameThread(notification.data.threadId)) return;
    const turnId = notification.data.turnId;
    if (turnId === undefined) return;
    const item = userMessageItemSchema.safeParse(notification.data.item);
    if (!item.success) {
      // Only an item the model starts after the message counts: one already
      // under way when a steer landed was sampled without it.
      const other = modelItemSchema.safeParse(notification.data.item);
      if (method === 'item/started' && other.success && MODEL_ITEM_TYPES.has(other.data.type)) {
        this.settle(turnId, 'model_output');
      }
      return;
    }
    const ids = new Set(renderedMessageIds(JSON.stringify(item.data.content ?? '')));
    if (item.data.clientId !== undefined && item.data.clientId !== null) {
      ids.add(item.data.clientId);
    }
    const ours = [...ids].filter((id) => this.pushed.has(id));
    if (ours.length === 0) return;
    const forTurn = this.recorded.get(turnId) ?? new Set<string>();
    for (const id of ours) forTurn.add(id);
    this.recorded.set(turnId, forTurn);
    if (this.completed.has(turnId)) this.settle(turnId, 'turn_completed');
  }

  private onTurnCompleted(params: Record<string, unknown> | undefined): void {
    const notification = turnNotificationSchema.safeParse(params);
    if (!notification.success || !this.sameThread(notification.data.threadId)) return;
    const { id, status } = notification.data.turn;
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
