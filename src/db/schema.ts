import { MESSAGING_V2_MIGRATION } from './messaging-v2-migration.js';
import { PROJECT_SCOPE_MIGRATION } from './project-scope-migration.js';

/**
 * Ordered, append-only list of SQL migrations. The migration runner in
 * `connection.ts` uses `PRAGMA user_version` to track how many have been
 * applied. Never edit or reorder an existing entry — only append new ones.
 */
export const migrations: readonly string[] = [
  // 001 — v0 core tables: tasks, handoffs, events.
  `
  CREATE TABLE tasks (
    task_id        TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    owner          TEXT,
    agent          TEXT,
    branch         TEXT,
    worktree       TEXT,
    expected_files TEXT NOT NULL DEFAULT '[]',
    modules        TEXT NOT NULL DEFAULT '[]',
    domains        TEXT NOT NULL DEFAULT '[]',
    risk_tags      TEXT NOT NULL DEFAULT '[]',
    notes          TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE handoffs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id            TEXT NOT NULL REFERENCES tasks(task_id),
    status             TEXT NOT NULL,
    changed_files      TEXT NOT NULL DEFAULT '[]',
    what_changed       TEXT NOT NULL,
    tests_run          TEXT NOT NULL DEFAULT '[]',
    known_risks        TEXT NOT NULL DEFAULT '[]',
    assumptions        TEXT NOT NULL DEFAULT '[]',
    decisions          TEXT NOT NULL DEFAULT '[]',
    guardrails_checked TEXT NOT NULL DEFAULT '[]',
    needs_review_from  TEXT NOT NULL DEFAULT '[]',
    next_steps         TEXT NOT NULL DEFAULT '[]',
    created_at         TEXT NOT NULL
  );

  CREATE INDEX idx_handoffs_task_id ON handoffs(task_id);

  CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT,
    tool       TEXT NOT NULL,
    status     TEXT NOT NULL,
    detail     TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_events_task_id ON events(task_id);
  `,
  // 002 — review packets produced by review_ready.
  `
  CREATE TABLE reviews (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id            TEXT NOT NULL REFERENCES tasks(task_id),
    plan_summary       TEXT NOT NULL,
    tests_run          TEXT NOT NULL DEFAULT '[]',
    diff_size          TEXT,
    guardrails_checked TEXT NOT NULL DEFAULT '[]',
    assumptions        TEXT NOT NULL DEFAULT '[]',
    open_questions     TEXT NOT NULL DEFAULT '[]',
    provenance         TEXT NOT NULL DEFAULT '[]',
    created_at         TEXT NOT NULL
  );

  CREATE INDEX idx_reviews_task_id ON reviews(task_id);
  `,
  // 003 — parent/child task decomposition. A soft reference (no FK): a subtask
  // may be claimed before or without its parent existing.
  `
  ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
  `,
  // 004 — append-only, task-scoped memory shared between agent sessions.
  `
  CREATE TABLE task_updates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES tasks(task_id),
    kind       TEXT NOT NULL,
    content    TEXT NOT NULL,
    agent      TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_task_updates_task_id ON task_updates(task_id);
  `,
  // 005 — agent presence registry. Each running agent registers a distinct
  // instance identity (agent_id) so concurrent agents are distinguishable and
  // can see who else is active. Liveness is derived from last_seen, not stored.
  `
  CREATE TABLE agents (
    agent_id   TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    owner      TEXT,
    model      TEXT,
    pid        INTEGER,
    cwd        TEXT,
    worktree   TEXT,
    branch     TEXT,
    summary    TEXT,
    status     TEXT NOT NULL DEFAULT 'active',
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  );

  CREATE INDEX idx_agents_last_seen ON agents(last_seen);
  `,
  // 006 — link a claim to the agent instance that made it, so stale claims
  // (an active task whose owning agent has gone away) can be detected. A soft
  // reference (no FK): the agent may register after, or not at all.
  `
  ALTER TABLE tasks ADD COLUMN agent_id TEXT;
  `,
  // 007 — versioned ownership lifecycle and acknowledged handoff delivery.
  // Existing task/handoff rows retain their legacy status and are upgraded with
  // safe defaults; all ownership changes are recorded append-only.
  `
  ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE tasks ADD COLUMN assigned_agent_id TEXT;
  ALTER TABLE tasks ADD COLUMN lease_expires_at TEXT;

  ALTER TABLE handoffs ADD COLUMN from_agent_id TEXT;
  ALTER TABLE handoffs ADD COLUMN to_agent_id TEXT;
  ALTER TABLE handoffs ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'recorded';
  ALTER TABLE handoffs ADD COLUMN expires_at TEXT;
  ALTER TABLE handoffs ADD COLUMN resolved_at TEXT;
  ALTER TABLE handoffs ADD COLUMN task_version INTEGER;
  ALTER TABLE handoffs ADD COLUMN resolution_reason TEXT;

  CREATE TABLE task_ownership_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT NOT NULL REFERENCES tasks(task_id),
    transition      TEXT NOT NULL,
    actor_agent_id  TEXT NOT NULL,
    from_agent_id   TEXT,
    to_agent_id     TEXT,
    from_status     TEXT NOT NULL,
    to_status       TEXT NOT NULL,
    from_version    INTEGER NOT NULL,
    to_version      INTEGER NOT NULL,
    reason          TEXT,
    created_at      TEXT NOT NULL
  );

  CREATE INDEX idx_ownership_events_task_id
    ON task_ownership_events(task_id, id);
  CREATE INDEX idx_handoffs_pending_recipient
    ON handoffs(to_agent_id, delivery_status);
  `,
  // 008 — addressable agent sessions and durable inter-agent messages.
  // Endpoint credentials and provider addresses remain local to the ignored
  // Concord database; generated artifacts expose only promptability/status.
  `
  CREATE TABLE agent_endpoints (
    endpoint_id      TEXT PRIMARY KEY,
    agent_id         TEXT NOT NULL REFERENCES agents(agent_id),
    provider         TEXT NOT NULL,
    transport        TEXT NOT NULL,
    capabilities     TEXT NOT NULL DEFAULT '[]',
    address          TEXT NOT NULL,
    credential_hash  TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'connected',
    last_seen        TEXT NOT NULL,
    expires_at       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    CHECK (status IN ('connected', 'disconnected'))
  );
  CREATE UNIQUE INDEX idx_agent_endpoints_agent
    ON agent_endpoints(agent_id);
  CREATE INDEX idx_agent_endpoints_status
    ON agent_endpoints(status, last_seen);

  CREATE TABLE agent_messages (
    message_id          TEXT PRIMARY KEY,
    task_id             TEXT REFERENCES tasks(task_id),
    sender_agent_id     TEXT NOT NULL REFERENCES agents(agent_id),
    recipient_agent_id  TEXT NOT NULL REFERENCES agents(agent_id),
    reply_to_message_id TEXT REFERENCES agent_messages(message_id),
    content             TEXT NOT NULL,
    delivery_mode       TEXT NOT NULL DEFAULT 'steer',
    status              TEXT NOT NULL DEFAULT 'pending',
    provider            TEXT,
    provider_receipt    TEXT,
    error_code          TEXT,
    error_detail        TEXT,
    idempotency_key     TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    delivered_at        TEXT,
    replied_at          TEXT,
    failed_at           TEXT,
    CHECK (delivery_mode = 'steer'),
    CHECK (status IN ('pending', 'delivered', 'replied', 'failed')),
    UNIQUE (sender_agent_id, idempotency_key)
  );
  CREATE INDEX idx_agent_messages_recipient
    ON agent_messages(recipient_agent_id, created_at, message_id);
  CREATE INDEX idx_agent_messages_sender
    ON agent_messages(sender_agent_id, created_at, message_id);
  CREATE INDEX idx_agent_messages_task
    ON agent_messages(task_id, created_at, message_id);

  CREATE TABLE agent_message_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT NOT NULL REFERENCES agent_messages(message_id),
    event       TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL,
    CHECK (event IN ('accepted', 'delivered', 'replied', 'failed'))
  );
  CREATE INDEX idx_agent_message_events_message
    ON agent_message_events(message_id, id);
  `,
  // 009 — short lease owned by the process that can wake an idle harness.
  // This is deliberately separate from the session endpoint lease: hooks can
  // prove that a session is alive, but cannot prove its background receiver is.
  `
  ALTER TABLE agent_endpoints ADD COLUMN receiver_expires_at TEXT;
  `,
  // 010 — optional, structured outcome evidence attached to a finish/handoff.
  `
  ALTER TABLE handoffs ADD COLUMN reported_outcome TEXT;
  `,
  // 011 — drain pending agent messages by recipient/status without scanning
  // the recipient's delivered/replied/failed history. The trailing ordering
  // columns also satisfy the pending-drain ORDER BY from the same index.
  `
  CREATE INDEX idx_agent_messages_pending_recipient
    ON agent_messages(recipient_agent_id, status, created_at, message_id);
  `,
  // 012 — tasks are unique per project, so one store can hold several.
  PROJECT_SCOPE_MIGRATION,
  // 013 — `delivered` means handed to the recipient's harness; `seen_at` means
  // the agent was actually shown it. A harness monitor can drain a message
  // while the session is blocked on its user, so the two can differ. Messages
  // delivered before this migration were counted as seen on delivery. The
  // events table is rebuilt because SQLite cannot widen a CHECK in place.
  `
  ALTER TABLE agent_messages ADD COLUMN seen_at TEXT;
  UPDATE agent_messages SET seen_at = delivered_at WHERE delivered_at IS NOT NULL;

  CREATE TABLE agent_message_events_013 (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT NOT NULL REFERENCES agent_messages(message_id),
    event       TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL,
    CHECK (event IN ('accepted', 'delivered', 'seen', 'requeued', 'replied', 'failed'))
  );
  INSERT INTO agent_message_events_013 SELECT * FROM agent_message_events;
  DROP TABLE agent_message_events;
  ALTER TABLE agent_message_events_013 RENAME TO agent_message_events;
  CREATE INDEX idx_agent_message_events_message
    ON agent_message_events(message_id, id);
  `,
  // 014 — when the session behind an endpoint last stopped to wait on its user
  // (a question or permission prompt), as reported by its own hooks. Shown to
  // senders; never used to hold delivery, since dismissing a prompt fires no
  // hook and a stale flag must not cost the agent its messages.
  `
  ALTER TABLE agent_endpoints ADD COLUMN awaiting_user_since TEXT;
  `,
  // 015 — messaging v2: sent/delivered/read/replied receipts, per-session
  // delivery attribution, and expiry for messages nobody ever took.
  MESSAGING_V2_MIGRATION,
  // 016 — decision supersession: a decision update can name an earlier decision
  // on the same task that it replaces. The replaced row records what replaced it.
  `
  ALTER TABLE task_updates ADD COLUMN superseded_by INTEGER REFERENCES task_updates(id);
  ALTER TABLE task_updates ADD COLUMN supersede_reason TEXT;
  ALTER TABLE task_updates ADD COLUMN superseded_at TEXT;
  `,
];
