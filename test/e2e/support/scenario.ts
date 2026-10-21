import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { HarnessSession } from '../drivers/session.js';
import { eventually } from './messages.js';

/**
 * Steps every scenario is built from, expressed as what an agent's model does
 * through its own MCP server — never by writing to Concord's database.
 */

export const sentSchema = z
  .object({
    message_id: z.string(),
    status: z.string(),
    recipient_agent_id: z.string(),
    delivery: z.enum(['delivered', 'queued_pull']),
    immediate_mode: z.enum(['inject', 'steer']).nullable(),
    outlook: z.string(),
  })
  .loose();
export type Sent = z.infer<typeof sentSchema>;

const agentViewSchema = z
  .object({
    promptable: z.boolean(),
    capabilities: z.array(z.string()),
    inbox: z.array(z.object({ messageId: z.string(), status: z.string() }).loose()),
  })
  .loose();

/** A unique, greppable message body. */
export function nonce(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

export function prompt(from: HarnessSession, to: HarnessSession, content: string): Promise<Sent> {
  return from.call(
    'update_work',
    {
      operation: 'prompt',
      to_agent_id: to.agentId,
      content,
      idempotency_key: randomUUID(),
    },
    sentSchema,
  );
}

export function reply(from: HarnessSession, messageId: string, content: string): Promise<Sent> {
  return from.call(
    'update_work',
    {
      operation: 'reply',
      reply_to_message_id: messageId,
      content,
      idempotency_key: randomUUID(),
    },
    sentSchema,
  );
}

/** What `observer` can see of `target`'s endpoint and inbox. */
export function inspectAgent(observer: HarnessSession, target: HarnessSession) {
  return observer.call('inspect_work', { agent_id: target.agentId }, agentViewSchema);
}

const threadSchema = z
  .object({
    thread: z.array(
      z
        .object({
          messageId: z.string(),
          status: z.string(),
          receipt: z.object({ ticks: z.string() }).loose(),
        })
        .loose(),
    ),
  })
  .loose();

/**
 * Where a message `sender` sent got to, read from the sender's own view of
 * the thread: another agent's inbox is private to it.
 */
export async function receiptOf(sender: HarnessSession, messageId: string) {
  const view = await sender.call('inspect_work', { message_id: messageId }, threadSchema);
  return view.thread.find((message) => message.messageId === messageId);
}

/** Wait until `target` advertises a live receiver that reaches it while idle. */
export async function untilIdleReachable(
  observer: HarnessSession,
  target: HarnessSession,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const view = await inspectAgent(observer, target);
    if (
      view.promptable &&
      (view.capabilities.includes('idle') || view.capabilities.includes('inject'))
    ) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${target.agentId} never became reachable while idle: ${view.capabilities.join(', ')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export { eventually };
