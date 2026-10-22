/**
 * Migration 015 — messaging v2 receipts.
 *
 * `pending` becomes `sent` (the store has it), `seen_at` becomes `read_at`
 * with `read` as its own status, and each delivery records which session took
 * it and how, so read evidence is credited only to that session. A message
 * still `sent` past `expires_at` fails as `expired`. SQLite cannot widen a
 * CHECK in place, so both tables are rebuilt.
 *
 * Open messages get a 24 hour expiry from when they were sent, matching
 * MESSAGE_TTL_MS in db/message-rows.ts.
 */
export const MESSAGING_V2_MIGRATION = `
  CREATE TABLE agent_messages_015 (
    message_id          TEXT PRIMARY KEY,
    task_id             TEXT,
    sender_agent_id     TEXT NOT NULL REFERENCES agents(agent_id),
    recipient_agent_id  TEXT NOT NULL REFERENCES agents(agent_id),
    reply_to_message_id TEXT REFERENCES agent_messages(message_id),
    content             TEXT NOT NULL,
    delivery_mode       TEXT NOT NULL DEFAULT 'steer',
    status              TEXT NOT NULL DEFAULT 'sent',
    provider            TEXT,
    provider_receipt    TEXT,
    error_code          TEXT,
    error_detail        TEXT,
    idempotency_key     TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    delivered_at        TEXT,
    delivered_session   TEXT,
    delivered_via       TEXT,
    read_at             TEXT,
    replied_at          TEXT,
    failed_at           TEXT,
    expires_at          TEXT,
    project             TEXT NOT NULL DEFAULT '',
    CHECK (delivery_mode = 'steer'),
    CHECK (status IN ('sent', 'delivered', 'read', 'replied', 'failed')),
    CHECK (delivered_via IS NULL OR delivered_via IN ('monitor', 'hook', 'adapter', 'inspect')),
    UNIQUE (sender_agent_id, idempotency_key),
    FOREIGN KEY (project, task_id) REFERENCES tasks(project, task_id)
  );
  INSERT INTO agent_messages_015 (
    message_id, task_id, sender_agent_id, recipient_agent_id, reply_to_message_id, content,
    delivery_mode, status, provider, provider_receipt, error_code, error_detail,
    idempotency_key, created_at, delivered_at, delivered_session, delivered_via, read_at,
    replied_at, failed_at, expires_at, project
  )
  SELECT
    message_id, task_id, sender_agent_id, recipient_agent_id, reply_to_message_id, content,
    delivery_mode,
    CASE
      WHEN status = 'pending' THEN 'sent'
      WHEN status = 'delivered' AND seen_at IS NOT NULL THEN 'read'
      ELSE status
    END,
    provider, provider_receipt, error_code, error_detail,
    idempotency_key, created_at, delivered_at, NULL, NULL,
    CASE WHEN status = 'replied' THEN COALESCE(seen_at, replied_at) ELSE seen_at END,
    replied_at, failed_at,
    CASE
      WHEN status = 'pending'
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
      ELSE NULL
    END,
    project
  FROM agent_messages;
  DROP TABLE agent_messages;
  ALTER TABLE agent_messages_015 RENAME TO agent_messages;
  CREATE INDEX idx_agent_messages_recipient
    ON agent_messages(recipient_agent_id, created_at, message_id);
  CREATE INDEX idx_agent_messages_sender
    ON agent_messages(sender_agent_id, created_at, message_id);
  CREATE INDEX idx_agent_messages_task
    ON agent_messages(project, task_id, created_at, message_id);
  CREATE INDEX idx_agent_messages_pending_recipient
    ON agent_messages(recipient_agent_id, status, created_at, message_id);

  CREATE TABLE agent_message_events_015 (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT NOT NULL REFERENCES agent_messages(message_id),
    event       TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL,
    CHECK (event IN ('sent', 'delivered', 'read', 'requeued', 'replied', 'failed', 'expired'))
  );
  INSERT INTO agent_message_events_015 (id, message_id, event, detail, created_at)
  SELECT
    id, message_id,
    CASE event WHEN 'accepted' THEN 'sent' WHEN 'seen' THEN 'read' ELSE event END,
    detail, created_at
  FROM agent_message_events;
  DROP TABLE agent_message_events;
  ALTER TABLE agent_message_events_015 RENAME TO agent_message_events;
  CREATE INDEX idx_agent_message_events_message
    ON agent_message_events(message_id, id);
`;
