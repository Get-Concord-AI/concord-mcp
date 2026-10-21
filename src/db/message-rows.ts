import { z } from 'zod';

/**
 * Messaging v2 statuses, WhatsApp-style: each is the furthest stage reached.
 *
 *   sent       the store committed it (✓)
 *   delivered  the recipient's own session took it into its harness (✓✓)
 *   read       that session's model provably had it in its input (blue ✓✓)
 *   replied    the recipient answered it (implies read)
 *   failed     it never reached anyone: expired, or the recipient vanished
 */
export const agentMessageStatusValues = ['sent', 'delivered', 'read', 'replied', 'failed'] as const;
export type AgentMessageStatus = (typeof agentMessageStatusValues)[number];
const agentMessageStatusSchema = z.enum(agentMessageStatusValues);

export const agentMessageErrorCodeValues = [
  'target_unreachable',
  'target_not_promptable',
  'capability_unavailable',
  'unauthorized',
  'delivery_timeout',
  'expired',
] as const;
export type AgentMessageErrorCode = (typeof agentMessageErrorCodeValues)[number];
const agentMessageErrorCodeSchema = z.enum(agentMessageErrorCodeValues);

/** How a delivered message entered the recipient's session. */
export const deliveryViaValues = ['monitor', 'hook', 'adapter', 'inspect'] as const;
export type DeliveryVia = (typeof deliveryViaValues)[number];
const deliveryViaSchema = z.enum(deliveryViaValues);

/** What proved a message reached the recipient model's input. */
export const readEvidenceValues = ['prompt', 'transcript', 'turn_completed', 'inspect'] as const;
export type ReadEvidence = (typeof readEvidenceValues)[number];
export const readEvidenceSchema = z.enum(readEvidenceValues);

export interface AgentMessageRecord {
  messageId: string;
  /** The project `taskId` belongs to; messages themselves span the store. */
  project: string;
  taskId: string | null;
  senderAgentId: string;
  recipientAgentId: string;
  replyToMessageId: string | null;
  content: string;
  deliveryMode: 'steer';
  status: AgentMessageStatus;
  provider: string | null;
  providerReceipt: string | null;
  errorCode: AgentMessageErrorCode | null;
  errorDetail: string | null;
  idempotencyKey: string;
  /** When the store committed it: the sent tick. */
  createdAt: string;
  deliveredAt: string | null;
  /** The opaque session key that took the delivery; null when it could not tell. */
  deliveredSession: string | null;
  deliveredVia: DeliveryVia | null;
  /** When the recipient's model was shown it; null while delivered but unread. */
  readAt: string | null;
  repliedAt: string | null;
  failedAt: string | null;
  /** A message still `sent` after this fails as `expired`. */
  expiresAt: string | null;
}

const agentMessageDbRowSchema = z.object({
  message_id: z.string(),
  project: z.string(),
  task_id: z.string().nullable(),
  sender_agent_id: z.string(),
  recipient_agent_id: z.string(),
  reply_to_message_id: z.string().nullable(),
  content: z.string(),
  delivery_mode: z.literal('steer'),
  status: agentMessageStatusSchema,
  provider: z.string().nullable(),
  provider_receipt: z.string().nullable(),
  error_code: agentMessageErrorCodeSchema.nullable(),
  error_detail: z.string().nullable(),
  idempotency_key: z.string(),
  created_at: z.string(),
  delivered_at: z.string().nullable(),
  delivered_session: z.string().nullable(),
  delivered_via: deliveryViaSchema.nullable(),
  read_at: z.string().nullable(),
  replied_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  expires_at: z.string().nullable(),
});

export function parseAgentMessageRow(raw: unknown): AgentMessageRecord {
  const row = agentMessageDbRowSchema.parse(raw);
  return {
    messageId: row.message_id,
    project: row.project,
    taskId: row.task_id,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    replyToMessageId: row.reply_to_message_id,
    content: row.content,
    deliveryMode: row.delivery_mode,
    status: row.status,
    provider: row.provider,
    providerReceipt: row.provider_receipt,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    deliveredSession: row.delivered_session,
    deliveredVia: row.delivered_via,
    readAt: row.read_at,
    repliedAt: row.replied_at,
    failedAt: row.failed_at,
    expiresAt: row.expires_at,
  };
}

export const agentMessageEventValues = [
  'sent',
  'delivered',
  'read',
  'requeued',
  'replied',
  'failed',
  'expired',
] as const;
export type AgentMessageEvent = (typeof agentMessageEventValues)[number];
const agentMessageEventSchema = z.enum(agentMessageEventValues);

export interface AgentMessageEventRecord {
  id: number;
  messageId: string;
  event: AgentMessageEvent;
  detail: string | null;
  createdAt: string;
}

const agentMessageEventDbRowSchema = z.object({
  id: z.number().int(),
  message_id: z.string(),
  event: agentMessageEventSchema,
  detail: z.string().nullable(),
  created_at: z.string(),
});

export function parseAgentMessageEventRow(raw: unknown): AgentMessageEventRecord {
  const row = agentMessageEventDbRowSchema.parse(raw);
  return {
    id: row.id,
    messageId: row.message_id,
    event: row.event,
    detail: row.detail,
    createdAt: row.created_at,
  };
}
