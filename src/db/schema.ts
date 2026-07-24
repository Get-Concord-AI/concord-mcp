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
];
