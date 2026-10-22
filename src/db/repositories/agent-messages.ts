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
  type DeliveryVia,
  type ReadEvidence,
  MESSAGE_TTL_MS,
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

export interface ClaimOptions {
  /** The opaque key of the session taking the messages, when it can tell. */
  session?: string | null | undefined;
  /** How they enter that session. Defaults to `hook`. */
  via?: DeliveryVia | undefined;
}

export interface AgentMessageRepository {
  create(message: NewAgentMessage): AgentMessageRecord;
  get(messageId: string): AgentMessageRecord | undefined;
  getByIdempotency(senderAgentId: string, idempotencyKey: string): AgentMessageRecord | undefined;
  listByAgent(agentId: string): AgentMessageRecord[];
  /** The newest messages in the store, oldest first: the human view. */
  listRecent(limit: number): AgentMessageRecord[];
  /** Messages waiting for `agentId`, oldest first, without claiming them. */
  listPendingForRecipient(agentId: string): AgentMessageRecord[];
  /**
   * Atomically take every `sent` message for `agentId`, marking each
   * delivered to `options.session` and returning only the ones this call
   * actually claimed. Never marks anything read.
   */
  claimPendingForRecipient(
    agentId: string,
    provider: string,
    options?: ClaimOptions,
  ): AgentMessageRecord[];
  /** Delivered-but-unread messages for `agentId` that `session` could produce evidence for. */
  listUnreadForSession(agentId: string, session: string | null): AgentMessageRecord[];
  /**
   * Record that `agentId`'s model was shown these messages. Only messages it
   * received, delivered to `session` (or to an unknown session), and not yet
   * read are changed; anything else is ignored.
   */
  markRead(
    agentId: string,
    session: string | null,
    messageIds: readonly string[],
    evidence: ReadEvidence,
  ): AgentMessageRecord[];
  /**
   * The recipient itself was handed these messages by a tool result
   * (inspect_work). Sent ones count as delivered too, whatever session holds them.
   */
  markReadByInspect(agentId: string, messageIds: readonly string[]): AgentMessageRecord[];
  /**
   * Evidence that itself proves delivery (a Codex turn that completed with the
   * message as input): a message still `sent` is recorded as delivered to
   * `session` first, so the read is never lost to a sender that has not yet
   * recorded its push.
   */
  markReadByEvidence(
    agentId: string,
    messageIds: readonly string[],
    options: { evidence: ReadEvidence; via: DeliveryVia; session: string | null },
  ): AgentMessageRecord[];
  /**
   * Return every message delivered to a named session other than `session`
   * and never read to the queue, so this agent's new session receives it
   * instead of losing it with the session it was handed to. A delivery whose
   * session is unknown is left alone: it may be this very session's.
   */
  requeueUnread(agentId: string, session: string | null): AgentMessageRecord[];
  /**
   * Return what `session` itself was handed but never read to the queue: the
   * session ended, so it never will read it. Sent again, it reaches the
   * agent's next session or expires, and the sender sees ✓ rather than a ✓✓
   * that will never turn read.
   */
  requeueSession(agentId: string, session: string): AgentMessageRecord[];
  /**
   * Settle what time alone has decided, before any receipt is shown:
   * - a delivered, unread message (monitor or adapter) whose recipient is no longer reachable (no
   *   live endpoint and no live receiver: its session ended without saying
   *   so) goes back to `sent`, because nobody holds it any more;
   * - a `sent` message past its expiry fails as `expired`.
   * Returns the messages that changed.
   */
  sweepStale(now?: Date): AgentMessageRecord[];
  listByTask(taskId: string): AgentMessageRecord[];
  listThread(messageId: string): AgentMessageRecord[];
  markDelivered(
    messageId: string,
    provider: string,
    receipt: string | null,
    options?: ClaimOptions,
  ): AgentMessageRecord;
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
      content, delivery_mode, status, idempotency_key, created_at, expires_at
    ) VALUES (
      @message_id, @project, @task_id, @sender_agent_id, @recipient_agent_id, @reply_to_message_id,
      @content, 'steer', 'sent', @idempotency_key, @created_at, @expires_at
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
  const listRecentStmt = db.prepare(`
    SELECT * FROM (
      SELECT * FROM agent_messages ORDER BY created_at DESC, message_id DESC LIMIT ?
    ) ORDER BY created_at, message_id
  `);
  const listPendingStmt = db.prepare(`
    SELECT * FROM agent_messages
    WHERE recipient_agent_id = ? AND status = 'sent'
    ORDER BY created_at, message_id
  `);
  const listByTaskStmt = db.prepare(`
    SELECT * FROM agent_messages WHERE project = ? AND task_id = ?
    ORDER BY created_at, message_id
  `);
  const markDeliveredStmt = db.prepare(`
    UPDATE agent_messages
    SET status = 'delivered', provider = @provider, provider_receipt = @receipt,
        delivered_at = @now, delivered_session = @session, delivered_via = @via,
        error_code = NULL, error_detail = NULL, failed_at = NULL
    WHERE message_id = @message_id AND status = 'sent'
  `);
  const markFailedStmt = db.prepare(`
    UPDATE agent_messages
    SET status = 'failed', error_code = @code, error_detail = @detail, failed_at = @now
    WHERE message_id = @message_id AND status = 'sent'
  `);
  const markRepliedStmt = db.prepare(`
    UPDATE agent_messages
    SET status = 'replied', replied_at = @now, read_at = COALESCE(read_at, @now),
        delivered_at = COALESCE(delivered_at, @now)
    WHERE message_id = @message_id AND status IN ('sent', 'delivered', 'read')
  `);
  // A delivery to an unknown session (a monitor that could not see its
  // session id) can be read by any of the recipient's sessions.
  const markReadStmt = db.prepare(`
    UPDATE agent_messages SET status = 'read', read_at = @now
    WHERE message_id = @message_id AND recipient_agent_id = @agent_id AND status = 'delivered'
      AND (delivered_session IS NULL OR delivered_session IS @session)
  `);
  const inspectDeliverStmt = db.prepare(`
    UPDATE agent_messages
    SET status = 'delivered', delivered_at = @now, delivered_via = @via,
        delivered_session = COALESCE(delivered_session, @session)
    WHERE message_id = @message_id AND recipient_agent_id = @agent_id AND status = 'sent'
  `);
  const inspectReadStmt = db.prepare(`
    UPDATE agent_messages SET status = 'read', read_at = @now
    WHERE message_id = @message_id AND recipient_agent_id = @agent_id AND status = 'delivered'
  `);
  const listUnreadStmt = db.prepare(`
    SELECT * FROM agent_messages
    WHERE recipient_agent_id = @agent_id AND status = 'delivered'
      AND (delivered_session IS NULL OR delivered_session IS @session)
    ORDER BY created_at, message_id
  `);
  const listRequeueableStmt = db.prepare(`
    SELECT * FROM agent_messages
    WHERE recipient_agent_id = @agent_id AND status = 'delivered'
      AND delivered_via IN ('monitor', 'hook', 'adapter')
      AND delivered_session IS NOT NULL AND delivered_session IS NOT @session
    ORDER BY created_at, message_id
  `);
  const listSessionUnreadStmt = db.prepare(`
    SELECT * FROM agent_messages
    WHERE recipient_agent_id = @agent_id AND status = 'delivered'
      AND delivered_via IN ('monitor', 'hook', 'adapter') AND delivered_session = @session
    ORDER BY created_at, message_id
  `);
  const requeueStmt = db.prepare(`
    UPDATE agent_messages
    SET status = 'sent', provider = NULL, provider_receipt = NULL, delivered_at = NULL,
        delivered_session = NULL, delivered_via = NULL,
        expires_at = MAX(COALESCE(expires_at, ''), @expires_at)
    WHERE message_id = @message_id AND status = 'delivered'
  `);
  // A session blocked on its user still heartbeats its monitor, so it stays
  // reachable and its held messages stay delivered. Only a session with
  // neither a live endpoint lease nor a live receiver lease is gone.
  // Hook deliveries are left out: a hook puts the message straight into the
  // model's context, and a hook-only session's lease lapses whenever its model
  // thinks for a while between tool calls, so an expired lease proves nothing.
  const listUnreachableStmt = db.prepare(`
    SELECT m.* FROM agent_messages m
    LEFT JOIN agent_endpoints e ON e.agent_id = m.recipient_agent_id
    WHERE m.status = 'delivered' AND m.delivered_via IN ('monitor', 'adapter')
      AND (
        e.agent_id IS NULL OR e.status <> 'connected'
        OR (e.expires_at IS NOT NULL AND e.expires_at < @now
            AND (e.receiver_expires_at IS NULL OR e.receiver_expires_at < @now))
      )
    ORDER BY m.created_at, m.message_id
  `);
  const listExpiredStmt = db.prepare(`
    SELECT message_id FROM agent_messages WHERE status = 'sent' AND expires_at < ?
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

  function claimPending(
    agentId: string,
    provider: string,
    options: ClaimOptions,
  ): AgentMessageRecord[] {
    sweepStale();
    const raw: unknown = listPendingStmt.all(agentId);
    const claimed: AgentMessageRecord[] = [];
    for (const row of rawListSchema.parse(raw).map(parseAgentMessageRow)) {
      const result = markDeliveredStmt.run({
        message_id: row.messageId,
        provider,
        receipt: null,
        now: new Date().toISOString(),
        session: options.session ?? null,
        via: options.via ?? 'hook',
      });
      if (result.changes === 0) continue;
      recordEvent(row.messageId, 'delivered', options.via ?? 'hook');
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

  function markRead(
    agentId: string,
    session: string | null,
    messageIds: readonly string[],
    evidence: ReadEvidence,
  ): AgentMessageRecord[] {
    const read: AgentMessageRecord[] = [];
    for (const messageId of new Set(messageIds)) {
      const result = markReadStmt.run({
        message_id: messageId,
        agent_id: agentId,
        session,
        now: new Date().toISOString(),
      });
      if (result.changes === 0) continue;
      recordEvent(messageId, 'read', evidence);
      read.push(requireMessage(messageId));
    }
    return read;
  }

  function markReadByEvidence(
    agentId: string,
    messageIds: readonly string[],
    options: { evidence: ReadEvidence; via: DeliveryVia; session: string | null },
  ): AgentMessageRecord[] {
    sweepStale();
    const read: AgentMessageRecord[] = [];
    for (const messageId of new Set(messageIds)) {
      const now = new Date().toISOString();
      const params = { message_id: messageId, agent_id: agentId, now };
      if (
        inspectDeliverStmt.run({ ...params, via: options.via, session: options.session }).changes >
        0
      ) {
        recordEvent(messageId, 'delivered', options.via);
      }
      if (inspectReadStmt.run(params).changes === 0) continue;
      recordEvent(messageId, 'read', options.evidence);
      read.push(requireMessage(messageId));
    }
    return read;
  }

  function listUnreadForSession(agentId: string, session: string | null): AgentMessageRecord[] {
    const raw: unknown = listUnreadStmt.all({ agent_id: agentId, session });
    return rawListSchema.parse(raw).map(parseAgentMessageRow);
  }

  function requeueUnread(agentId: string, session: string | null): AgentMessageRecord[] {
    return requeueRows(listRequeueableStmt.all({ agent_id: agentId, session }));
  }

  function requeueSession(agentId: string, session: string): AgentMessageRecord[] {
    return requeueRows(listSessionUnreadStmt.all({ agent_id: agentId, session }));
  }

  function requeueRows(raw: unknown, reason?: string): AgentMessageRecord[] {
    const requeued: AgentMessageRecord[] = [];
    // A requeued message gets a fresh day to be taken again.
    const expiresAt = new Date(Date.now() + MESSAGE_TTL_MS).toISOString();
    for (const message of rawListSchema.parse(raw).map(parseAgentMessageRow)) {
      const result = requeueStmt.run({ message_id: message.messageId, expires_at: expiresAt });
      if (result.changes === 0) continue;
      recordEvent(message.messageId, 'requeued', reason ?? message.deliveredSession);
      requeued.push(requireMessage(message.messageId));
    }
    return requeued;
  }

  function sweepStale(now: Date = new Date()): AgentMessageRecord[] {
    const unreachable = requeueRows(
      listUnreachableStmt.all({ now: now.toISOString() }),
      'unreachable',
    );
    return [...unreachable, ...expireSent(now)];
  }

  function expireSent(now: Date): AgentMessageRecord[] {
    const raw: unknown = listExpiredStmt.all(now.toISOString());
    const ids = z.array(z.object({ message_id: z.string() })).parse(raw);
    const expired: AgentMessageRecord[] = [];
    for (const { message_id: messageId } of ids) {
      const result = markFailedStmt.run({
        message_id: messageId,
        code: 'expired',
        detail: 'Nobody took this message before it expired.',
        now: now.toISOString(),
      });
      if (result.changes === 0) continue;
      recordEvent(messageId, 'expired');
      expired.push(requireMessage(messageId));
    }
    return expired;
  }

  // Acquire the write reservation before listPendingStmt reads. A deferred
  // transaction can otherwise read an old WAL snapshot, lose a race to a
  // sender, and fail its write upgrade with SQLITE_BUSY_SNAPSHOT.
  const claimTransaction = db.transaction(claimPending);
  const markReadTransaction = db.transaction(markRead);
  const markReadByEvidenceTransaction = db.transaction(markReadByEvidence);
  const requeueTransaction = db.transaction(requeueUnread);
  const requeueSessionTransaction = db.transaction(requeueSession);
  const sweepTransaction = db.transaction(sweepStale);

  return {
    create(message) {
      const now = new Date();
      insertStmt.run({
        message_id: message.messageId,
        project: message.project ?? project,
        task_id: message.taskId,
        sender_agent_id: message.senderAgentId,
        recipient_agent_id: message.recipientAgentId,
        reply_to_message_id: message.replyToMessageId,
        content: message.content,
        idempotency_key: message.idempotencyKey,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + MESSAGE_TTL_MS).toISOString(),
      });
      const stored = requireMessage(message.messageId);
      recordEvent(stored.messageId, 'sent');
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
    listRecent(limit) {
      const raw: unknown = listRecentStmt.all(limit);
      return rawListSchema.parse(raw).map(parseAgentMessageRow);
    },
    listPendingForRecipient(agentId) {
      const raw: unknown = listPendingStmt.all(agentId);
      return rawListSchema.parse(raw).map(parseAgentMessageRow);
    },
    claimPendingForRecipient(agentId, provider, options = {}) {
      // A Claude Code session drains from both a 2s monitor poll and a
      // PostToolUse hook, so two drains overlap routinely. The UPDATE is the
      // claim: whoever flips the row out of 'sent' owns the message, and
      // the loser emits nothing rather than showing the agent a duplicate.
      return claimTransaction.immediate(agentId, provider, options);
    },
    listUnreadForSession,
    markRead(agentId, session, messageIds, evidence) {
      return markReadTransaction.immediate(agentId, session, messageIds, evidence);
    },
    markReadByInspect(agentId, messageIds) {
      return markReadByEvidenceTransaction.immediate(agentId, messageIds, {
        evidence: 'inspect',
        via: 'inspect',
        session: null,
      });
    },
    markReadByEvidence(agentId, messageIds, options) {
      return markReadByEvidenceTransaction.immediate(agentId, messageIds, options);
    },
    requeueUnread(agentId, session) {
      return requeueTransaction.immediate(agentId, session);
    },
    requeueSession(agentId, session) {
      return requeueSessionTransaction.immediate(agentId, session);
    },
    sweepStale(now) {
      return sweepTransaction.immediate(now);
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
    markDelivered(messageId, provider, receipt, options = {}) {
      // A push the recipient's harness accepted. Accepting is not reading: the
      // adapter reports read once the turn it started or steered completes.
      const via = options.via ?? 'adapter';
      const result = markDeliveredStmt.run({
        message_id: messageId,
        provider,
        receipt,
        now: new Date().toISOString(),
        session: options.session ?? null,
        via,
      });
      const stored = requireMessage(messageId);
      if (result.changes > 0) recordEvent(messageId, 'delivered', via);
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
      const before = get(messageId);
      const result = markRepliedStmt.run({
        message_id: messageId,
        now: new Date().toISOString(),
      });
      const stored = requireMessage(messageId);
      if (result.changes > 0) {
        // A reply is proof of reading, so the timeline shows both.
        if (before?.readAt === null) recordEvent(messageId, 'read', 'reply');
        recordEvent(messageId, 'replied');
      }
      return stored;
    },
    recordEvent,
    listEvents(messageId) {
      const raw: unknown = listEventsStmt.all(messageId);
      return rawListSchema.parse(raw).map(parseAgentMessageEventRow);
    },
  };
}
