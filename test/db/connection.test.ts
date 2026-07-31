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
    expect(version).toBe(8);

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
    expect(upgraded.pragma('user_version', { simple: true })).toBe(8);
    expect(task.status).toBe('handed_off');
    expect(task.agentId).toBe('codex:old');
    expect(task.version).toBe(1);
    expect(task.assignedAgentId).toBeNull();
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
