import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { LOCAL_PROJECT } from '../project-scope-migration.js';
import {
  parseAgentMessageEventRow,
  parseAgentMessageRow,
  type AgentMessageErrorCode,
  type AgentMessageEvent,
  type AgentMessageEventRecord,
  type AgentMessageRecord,
} from '../rows.js';

export interface NewAgentMessage {
  messageId: string;
  /** The project `taskId` belongs to, when not this repository's (a reply's). */
  project?: string | undefined;
  taskId: string | null;
  senderAgentId: string;
  recipientAgentId: string;
  replyToMessageId: string | null;
  content: string;
  idempotencyKey: string;
}

export interface AgentMessageRepository {
  create(message: NewAgentMessage): AgentMessageRecord;
  get(messageId: string): AgentMessageRecord | undefined;
  getByIdempotency(senderAgentId: string, idempotencyKey: string): AgentMessageRecord | undefined;
  listByAgent(agentId: string): AgentMessageRecord[];
  /** Messages waiting for `agentId`, oldest first, without claiming them. */
  listPendingForRecipient(agentId: string): AgentMessageRecord[];
  /**
   * Atomically take every pending message for `agentId`, marking each
   * delivered and returning only the ones this call actually claimed.
   */
  claimPendingForRecipient(agentId: string, provider: string): AgentMessageRecord[];
  listByTask(taskId: string): AgentMessageRecord[];
  listThread(messageId: string): AgentMessageRecord[];
  markDelivered(messageId: string, provider: string, receipt: string | null): AgentMessageRecord;
  markFailed(
    messageId: string,
    code: AgentMessageErrorCode,
    detail: string | null,
  ): AgentMessageRecord;
  markReplied(messageId: string): AgentMessageRecord;
  recordEvent(messageId: string, event: AgentMessageEvent, detail?: string | null): void;
  listEvents(messageId: string): AgentMessageEventRecord[];
}

const rawListSchema = z.array(z.unknown());

/** Messages span the store; only the task a message names is scoped to `project`. */
export function createAgentMessageRepository(
  db: ConcordDatabase,
  project: string = LOCAL_PROJECT,
): AgentMessageRepository {
  const insertStmt = db.prepare(`
    INSERT INTO agent_messages (
      message_id, project, task_id, sender_agent_id, recipient_agent_id, reply_to_message_id,
      content, delivery_mode, status, idempotency_key, created_at
    ) VALUES (
      @message_id, @project, @task_id, @sender_agent_id, @recipient_agent_id, @reply_to_message_id,
      @content, 'steer', 'pending', @idempotency_key, @created_at
    )
  `);
  const getStmt = db.prepare('SELECT * FROM agent_messages WHERE message_id = ?');
  const idempotencyStmt = db.prepare(`
    SELECT * FROM agent_messages WHERE sender_agent_id = ? AND idempotency_key = ?
  `);
  const listByAgentStmt = db.prepare(`
    SELECT * FROM agent_messages
    WHERE sender_agent_id = ? OR recipient_agent_id = ?
    ORDER BY created_at, message_id
  `);
  const listPendingStmt = db.prepare(`
    SELECT * FROM agent_messages
    WHERE recipient_agent_id = ? AND status = 'pending'
    ORDER BY created_at, message_id
  `);
  const listByTaskStmt = db.prepare(`
    SELECT * FROM agent_messages WHERE project = ? AND task_id = ?
    ORDER BY created_at, message_id
  `);
  const markDeliveredStmt = db.prepare(`
    UPDATE agent_messages
    SET status = 'delivered', provider = @provider, provider_receipt = @receipt,
        delivered_at = @now, error_code = NULL, error_detail = NULL, failed_at = NULL
    WHERE message_id = @message_id AND status = 'pending'
  `);
  const markFailedStmt = db.prepare(`
    UPDATE agent_messages
    SET status = 'failed', error_code = @code, error_detail = @detail, failed_at = @now
    WHERE message_id = @message_id AND status = 'pending'
  `);
  const markRepliedStmt = db.prepare(`
    UPDATE agent_messages SET status = 'replied', replied_at = @now
    WHERE message_id = @message_id AND status = 'delivered'
  `);
  const eventStmt = db.prepare(`
    INSERT INTO agent_message_events (message_id, event, detail, created_at)
    VALUES (@message_id, @event, @detail, @created_at)
  `);
  const listEventsStmt = db.prepare(`
    SELECT * FROM agent_message_events WHERE message_id = ? ORDER BY id
  `);

  function get(messageId: string): AgentMessageRecord | undefined {
    const raw: unknown = getStmt.get(messageId);
    return raw === undefined ? undefined : parseAgentMessageRow(raw);
  }

  function requireMessage(messageId: string): AgentMessageRecord {
    const message = get(messageId);
    if (message === undefined) {
      throw new Error(`Agent message ${messageId} could not be read back`);
    }
    return message;
  }

  function claimPending(agentId: string, provider: string): AgentMessageRecord[] {
    const raw: unknown = listPendingStmt.all(agentId);
    const claimed: AgentMessageRecord[] = [];
    for (const row of rawListSchema.parse(raw).map(parseAgentMessageRow)) {
      const result = markDeliveredStmt.run({
        message_id: row.messageId,
        provider,
        receipt: null,
        now: new Date().toISOString(),
      });
      if (result.changes === 0) continue;
      recordEvent(row.messageId, 'delivered', provider);
      claimed.push(requireMessage(row.messageId));
    }
    return claimed;
  }

  function recordEvent(
    messageId: string,
    event: AgentMessageEvent,
    detail: string | null = null,
  ): void {
    eventStmt.run({ message_id: messageId, event, detail, created_at: new Date().toISOString() });
  }

  // Acquire the write reservation before listPendingStmt reads. A deferred
  // transaction can otherwise read an old WAL snapshot, lose a race to a
  // sender, and fail its write upgrade with SQLITE_BUSY_SNAPSHOT.
  const claimTransaction = db.transaction(claimPending);

  return {
    create(message) {
      insertStmt.run({
        message_id: message.messageId,
        project: message.project ?? project,
        task_id: message.taskId,
        sender_agent_id: message.senderAgentId,
        recipient_agent_id: message.recipientAgentId,
        reply_to_message_id: message.replyToMessageId,
        content: message.content,
        idempotency_key: message.idempotencyKey,
        created_at: new Date().toISOString(),
      });
      const stored = requireMessage(message.messageId);
      recordEvent(stored.messageId, 'accepted');
      return stored;
    },
    get,
    getByIdempotency(senderAgentId, idempotencyKey) {
      const raw: unknown = idempotencyStmt.get(senderAgentId, idempotencyKey);
      return raw === undefined ? undefined : parseAgentMessageRow(raw);
    },
    listByAgent(agentId) {
      const raw: unknown = listByAgentStmt.all(agentId, agentId);
      return rawListSchema.parse(raw).map(parseAgentMessageRow);
    },
    listPendingForRecipient(agentId) {
      const raw: unknown = listPendingStmt.all(agentId);
      return rawListSchema.parse(raw).map(parseAgentMessageRow);
    },
    claimPendingForRecipient(agentId, provider) {
      // A Claude Code session drains from both a 2s monitor poll and a
      // PostToolUse hook, so two drains overlap routinely. The UPDATE is the
      // claim: whoever flips the row out of 'pending' owns the message, and
      // the loser emits nothing rather than showing the agent a duplicate.
      return claimTransaction.immediate(agentId, provider);
    },
    listByTask(taskId) {
      const raw: unknown = listByTaskStmt.all(project, taskId);
      return rawListSchema.parse(raw).map(parseAgentMessageRow);
    },
    listThread(messageId) {
      const messages: AgentMessageRecord[] = [];
      let root = requireMessage(messageId);
      while (root.replyToMessageId !== null) {
        root = requireMessage(root.replyToMessageId);
      }
      messages.push(root);
      let frontier = [root.messageId];
      while (frontier.length > 0) {
        const placeholders = frontier.map(() => '?').join(', ');
        const raw: unknown = db
          .prepare(
            `SELECT * FROM agent_messages WHERE reply_to_message_id IN (${placeholders}) ORDER BY created_at, message_id`,
          )
          .all(...frontier);
        const children = rawListSchema.parse(raw).map(parseAgentMessageRow);
        messages.push(...children);
        frontier = children.map((message) => message.messageId);
      }
      return messages;
    },
    markDelivered(messageId, provider, receipt) {
      const result = markDeliveredStmt.run({
        message_id: messageId,
        provider,
        receipt,
        now: new Date().toISOString(),
      });
      const stored = requireMessage(messageId);
      if (result.changes > 0) recordEvent(messageId, 'delivered', provider);
      return stored;
    },
    markFailed(messageId, code, detail) {
      const result = markFailedStmt.run({
        message_id: messageId,
        code,
        detail,
        now: new Date().toISOString(),
      });
      const stored = requireMessage(messageId);
      if (result.changes > 0) recordEvent(messageId, 'failed', code);
      return stored;
    },
    markReplied(messageId) {
      const result = markRepliedStmt.run({
        message_id: messageId,
        now: new Date().toISOString(),
      });
      const stored = requireMessage(messageId);
      if (result.changes > 0) recordEvent(messageId, 'replied');
      return stored;
    },
    recordEvent,
    listEvents(messageId) {
      const raw: unknown = listEventsStmt.all(messageId);
      return rawListSchema.parse(raw).map(parseAgentMessageEventRow);
    },
  };
}
