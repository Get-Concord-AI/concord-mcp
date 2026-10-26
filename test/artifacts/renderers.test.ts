import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { renderEventsJsonl } from '../../src/artifacts/events-jsonl.js';
import { bulletList, codeBulletList } from '../../src/artifacts/markdown.js';
import type { EventRecord } from '../../src/db/index.js';

describe('markdown list renderers', () => {
  it('uses a placeholder for empty lists', () => {
    expect(bulletList([])).toBe('_None_');
    expect(codeBulletList([])).toBe('_None_');
  });

  it('renders each item on its own line', () => {
    expect(bulletList(['alpha', 'beta'])).toBe('- alpha\n- beta');
    expect(codeBulletList(['src/a.ts', 'src/b.ts'])).toBe('- `src/a.ts`\n- `src/b.ts`');
  });
});

describe('renderEventsJsonl', () => {
  it('returns an empty string for no events', () => {
    expect(renderEventsJsonl([])).toBe('');
  });

  it('preserves event order, snake_case fields, and a trailing newline', () => {
    const events: EventRecord[] = [
      {
        id: 1,
        taskId: 'TASK-1',
        tool: 'claim_work',
        status: 'success',
        detail: 'started',
        createdAt: '2026-10-20T01:00:00Z',
      },
      {
        id: 2,
        taskId: null,
        tool: 'handoff',
        status: 'error',
        detail: null,
        createdAt: '2026-10-20T02:00:00Z',
      },
    ];
    const output = renderEventsJsonl(events);
    // Assert the exact serialized lines before Zod parsing: parsing would strip
    // unexpected extra fields and hide changes to field order or the JSONL format.
    expect(output).toBe(
      [
        '{"task_id":"TASK-1","tool":"claim_work","status":"success","detail":"started","created_at":"2026-10-20T01:00:00Z"}',
        '{"task_id":null,"tool":"handoff","status":"error","detail":null,"created_at":"2026-10-20T02:00:00Z"}',
        '',
      ].join('\n'),
    );
    expect(output.endsWith('\n')).toBe(true);
    const lines = output.slice(0, -1).split('\n');
    expect(lines).toHaveLength(2);
    const expectedKeys = ['task_id', 'tool', 'status', 'detail', 'created_at'];
    const eventSchema = z.object({
      task_id: z.string().nullable(),
      tool: z.string(),
      status: z.string(),
      detail: z.string().nullable(),
      created_at: z.string(),
    });
    const parsedEvents = lines.map((line) => {
      const parsed = eventSchema.parse(JSON.parse(line));
      expect(Object.keys(parsed)).toEqual(expectedKeys);
      return parsed;
    });
    expect(parsedEvents[0]).toEqual({
      task_id: 'TASK-1',
      tool: 'claim_work',
      status: 'success',
      detail: 'started',
      created_at: '2026-10-20T01:00:00Z',
    });
    expect(parsedEvents[1]).toEqual({
      task_id: null,
      tool: 'handoff',
      status: 'error',
      detail: null,
      created_at: '2026-10-20T02:00:00Z',
    });
  });
});
