import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { parseStringArray, parseTaskRow, serializeStringArray } from '../../src/db/rows.js';

describe('openDatabase', () => {
  it('applies all migrations (user_version at head) and creates tables', () => {
    const db = openDatabase(':memory:');
    const version: unknown = db.pragma('user_version', { simple: true });
    expect(version).toBe(6);

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
