import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { parseStringArray, parseTaskRow, serializeStringArray } from '../../src/db/rows.js';
import { migrations } from '../../src/db/schema.js';

describe('openDatabase', () => {
  it('applies all migrations (user_version at head) and creates tables', () => {
    const db = openDatabase(':memory:');
    const version: unknown = db.pragma('user_version', { simple: true });
    expect(version).toBe(16);

    const raw: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const names = new Set(
      z
        .array(z.object({ name: z.string() }))
        .parse(raw)
        .map((r) => r.name),
    );
    expect(names.has('tasks')).toBe(true);
    expect(names.has('handoffs')).toBe(true);
    expect(names.has('events')).toBe(true);
    expect(names.has('reviews')).toBe(true);
    expect(names.has('task_updates')).toBe(true);
    expect(names.has('agents')).toBe(true);
    expect(names.has('task_ownership_events')).toBe(true);
    expect(names.has('agent_endpoints')).toBe(true);
    expect(names.has('agent_messages')).toBe(true);
    expect(names.has('agent_message_events')).toBe(true);
  });

  it('adds an index tailored to pending recipient drains', () => {
    const db = openDatabase(':memory:');
    const raw: unknown = db.pragma('index_info(idx_agent_messages_pending_recipient)');
    const columns = z
      .array(z.object({ seqno: z.number(), cid: z.number(), name: z.string() }))
      .parse(raw)
      .sort((a, b) => a.seqno - b.seqno)
      .map((entry) => entry.name);

    expect(columns).toEqual(['recipient_agent_id', 'status', 'created_at', 'message_id']);
  });

  it('refuses a database a newer Concord already upgraded', () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'concord-newer-')), 'newer.db');
    const newer = new Database(filename);
    newer.pragma(`user_version = ${String(migrations.length + 1)}`);
    newer.close();

    expect(() => openDatabase(filename)).toThrow(/upgraded by a newer Concord/);
  });

  it('upgrades a version-6 database without losing legacy task ownership', () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'concord-upgrade-')), 'legacy.db');
    const legacy = new Database(filename);
    for (let index = 0; index < 6; index += 1) {
      legacy.exec(migrations[index] ?? '');
      legacy.pragma(`user_version = ${String(index + 1)}`);
    }
    legacy
      .prepare(
        `INSERT INTO tasks (
          task_id, title, owner, agent, branch, worktree, expected_files,
          modules, domains, risk_tags, notes, status, parent_task_id, agent_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'LEGACY',
        'Legacy task',
        'alex',
        'codex',
        null,
        null,
        '[]',
        '[]',
        '[]',
        '[]',
        null,
        'handed_off',
        null,
        'codex:old',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    legacy.close();

    const upgraded = openDatabase(filename);
    const task = parseTaskRow(
      upgraded.prepare('SELECT * FROM tasks WHERE task_id = ?').get('LEGACY'),
    );
    expect(upgraded.pragma('user_version', { simple: true })).toBe(16);
    expect(task.status).toBe('handed_off');
    expect(task.agentId).toBe('codex:old');
    expect(task.version).toBe(1);
    expect(task.assignedAgentId).toBeNull();
  });
});

describe('messaging v2 migration', () => {
  it('maps v1 messages onto sent/delivered/read/replied receipts and keeps their history', () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'concord-v2-')), 'v12.db');
    const legacy = new Database(filename);
    for (let index = 0; index < 12; index += 1) {
      legacy.exec(migrations[index] ?? '');
      legacy.pragma(`user_version = ${String(index + 1)}`);
    }
    const at = '2026-01-01T00:00:00.000Z';
    const agent = legacy.prepare(
      "INSERT INTO agents (agent_id, kind, first_seen, last_seen) VALUES (?, 'claude-code', ?, ?)",
    );
    agent.run('alpha', at, at);
    agent.run('beta', at, at);
    const message = legacy.prepare(
      `INSERT INTO agent_messages (
        message_id, sender_agent_id, recipient_agent_id, content, status,
        idempotency_key, created_at, delivered_at, replied_at
      ) VALUES (?, 'alpha', 'beta', 'hi', ?, ?, ?, ?, ?)`,
    );
    message.run('m-delivered', 'delivered', 'k1', at, at, null);
    message.run('m-pending', 'pending', 'k2', at, null, null);
    message.run('m-replied', 'replied', 'k3', at, at, at);
    const event = legacy.prepare(
      'INSERT INTO agent_message_events (message_id, event, created_at) VALUES (?, ?, ?)',
    );
    event.run('m-delivered', 'accepted', at);
    event.run('m-delivered', 'delivered', at);
    legacy.close();

    const upgraded = openDatabase(filename);
    const rows = z
      .array(
        z.object({
          message_id: z.string(),
          status: z.string(),
          read_at: z.string().nullable(),
          expires_at: z.string().nullable(),
        }),
      )
      .parse(
        upgraded
          .prepare('SELECT message_id, status, read_at, expires_at FROM agent_messages ORDER BY 1')
          .all(),
      );
    // v1 counted a drain as the agent seeing it, so those carry over as read.
    expect(rows).toEqual([
      { message_id: 'm-delivered', status: 'read', read_at: at, expires_at: null },
      {
        message_id: 'm-pending',
        status: 'sent',
        read_at: null,
        expires_at: '2026-01-02T00:00:00.000Z',
      },
      { message_id: 'm-replied', status: 'replied', read_at: at, expires_at: null },
    ]);
    const events: unknown = upgraded
      .prepare(
        "SELECT event FROM agent_message_events WHERE message_id = 'm-delivered' ORDER BY id",
      )
      .all();
    expect(events).toEqual([{ event: 'sent' }, { event: 'delivered' }]);
    // The widened CHECK accepts the new lifecycle events.
    upgraded
      .prepare(
        "INSERT INTO agent_message_events (message_id, event, created_at) VALUES ('m-delivered', 'read', ?)",
      )
      .run(at);
  });
});

describe('messaging v2 migration from the #208 branch', () => {
  it('carries seen_at over as read, and keeps unseen deliveries delivered', () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'concord-v14-')), 'v14.db');
    const legacy = new Database(filename);
    for (let index = 0; index < 14; index += 1) {
      legacy.exec(migrations[index] ?? '');
      legacy.pragma(`user_version = ${String(index + 1)}`);
    }
    const at = '2026-01-01T00:00:00.000Z';
    const agent = legacy.prepare(
      "INSERT INTO agents (agent_id, kind, first_seen, last_seen) VALUES (?, 'claude-code', ?, ?)",
    );
    agent.run('alpha', at, at);
    agent.run('beta', at, at);
    const message = legacy.prepare(
      `INSERT INTO agent_messages (
        message_id, sender_agent_id, recipient_agent_id, content, status,
        idempotency_key, created_at, delivered_at, seen_at
      ) VALUES (?, 'alpha', 'beta', 'hi', 'delivered', ?, ?, ?, ?)`,
    );
    message.run('m-seen', 'k1', at, at, at);
    message.run('m-unseen', 'k2', at, at, null);
    legacy
      .prepare(
        "INSERT INTO agent_message_events (message_id, event, created_at) VALUES ('m-seen', 'seen', ?)",
      )
      .run(at);
    legacy.close();

    const upgraded = openDatabase(filename);
    const rows = z
      .array(
        z.object({ message_id: z.string(), status: z.string(), read_at: z.string().nullable() }),
      )
      .parse(
        upgraded.prepare('SELECT message_id, status, read_at FROM agent_messages ORDER BY 1').all(),
      );
    expect(rows).toEqual([
      { message_id: 'm-seen', status: 'read', read_at: at },
      { message_id: 'm-unseen', status: 'delivered', read_at: null },
    ]);
    expect(
      upgraded.prepare("SELECT event FROM agent_message_events WHERE message_id = 'm-seen'").all(),
    ).toEqual([{ event: 'read' }]);
  });
});

describe('row parsing', () => {
  it('round-trips a string array through serialize/parse', () => {
    expect(parseStringArray(serializeStringArray(['a', 'b']))).toEqual(['a', 'b']);
    expect(parseStringArray('[]')).toEqual([]);
  });

  it('parses a raw task row into a camelCased record', () => {
    const record = parseTaskRow({
      task_id: 'TASK-1',
      title: 'Test',
      owner: null,
      agent: 'codex',
      branch: null,
      worktree: null,
      expected_files: '["src/a.ts"]',
      modules: '["billing"]',
      domains: '[]',
      risk_tags: '[]',
      notes: null,
      status: 'active',
      parent_task_id: null,
      agent_id: null,
      version: 1,
      assigned_agent_id: null,
      lease_expires_at: null,
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z',
    });
    expect(record.taskId).toBe('TASK-1');
    expect(record.expectedFiles).toEqual(['src/a.ts']);
    expect(record.modules).toEqual(['billing']);
    expect(record.agent).toBe('codex');
  });

  it('rejects a malformed row (unknown status)', () => {
    expect(() => parseTaskRow({ task_id: 'x', status: 'bogus' })).toThrow();
  });
});
