import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
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

export function createAgentMessageRepository(db: ConcordDatabase): AgentMessageRepository {
  const insertStmt = db.prepare(`
    INSERT INTO agent_messages (
      message_id, task_id, sender_agent_id, recipient_agent_id, reply_to_message_id,
      content, delivery_mode, status, idempotency_key, created_at
    ) VALUES (
      @message_id, @task_id, @sender_agent_id, @recipient_agent_id, @reply_to_message_id,
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
  const listByTaskStmt = db.prepare(`
    SELECT * FROM agent_messages WHERE task_id = ? ORDER BY created_at, message_id
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

  function recordEvent(
    messageId: string,
    event: AgentMessageEvent,
    detail: string | null = null,
  ): void {
    eventStmt.run({ message_id: messageId, event, detail, created_at: new Date().toISOString() });
  }

  return {
    create(message) {
      insertStmt.run({
        message_id: message.messageId,
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
    listByTask(taskId) {
      const raw: unknown = listByTaskStmt.all(taskId);
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
