import { z } from 'zod';

/**
 * The Codex app-server notifications Concord follows, parsed once where they
 * arrive so listeners get typed values. Anything else is ignored.
 */

const textPartSchema = z.object({ type: z.string(), text: z.string().optional() }).loose();
const itemSchema = z
  .object({
    type: z.string(),
    clientId: z.string().nullable().optional(),
    content: z.array(textPartSchema).optional().catch(undefined),
  })
  .loose();
const itemNotificationSchema = z
  .object({
    method: z.enum(['item/started', 'item/completed']),
    params: z
      .object({ threadId: z.string().optional(), turnId: z.string().optional(), item: itemSchema })
      .loose(),
  })
  .loose();
const turnNotificationSchema = z
  .object({
    method: z.enum(['turn/started', 'turn/completed']),
    params: z
      .object({
        threadId: z.string().optional(),
        turn: z.object({ id: z.string(), status: z.string().optional() }).loose(),
      })
      .loose(),
  })
  .loose();

export interface CodexItem {
  type: string;
  clientId: string | null;
  /** The item's text parts joined, for finding a rendered `[concord from … id=…]` header. */
  text: string;
}

export type CodexNotification =
  | {
      method: 'item/started' | 'item/completed';
      threadId: string | undefined;
      turnId: string | undefined;
      item: CodexItem;
    }
  | {
      method: 'turn/started' | 'turn/completed';
      threadId: string | undefined;
      turn: { id: string; status: string | undefined };
    };

export function parseCodexNotification(value: unknown): CodexNotification | undefined {
  const item = itemNotificationSchema.safeParse(value);
  if (item.success) {
    const { threadId, turnId, item: raw } = item.data.params;
    return {
      method: item.data.method,
      threadId,
      turnId,
      item: {
        type: raw.type,
        clientId: raw.clientId ?? null,
        text: (raw.content ?? []).map((part) => part.text ?? '').join('\n'),
      },
    };
  }
  const turn = turnNotificationSchema.safeParse(value);
  if (turn.success) {
    const { threadId, turn: raw } = turn.data.params;
    return { method: turn.data.method, threadId, turn: { id: raw.id, status: raw.status } };
  }
  return undefined;
}
