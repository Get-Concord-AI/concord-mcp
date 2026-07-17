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
];
