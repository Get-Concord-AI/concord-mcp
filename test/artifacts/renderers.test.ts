import { describe, expect, it } from 'vitest';

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
      { id: 1, taskId: 'TASK-1', tool: 'claim_work', status: 'success', detail: 'started', createdAt: '2026-10-20T01:00:00Z' },
      { id: 2, taskId: null, tool: 'handoff', status: 'error', detail: null, createdAt: '2026-10-20T02:00:00Z' },
    ];
    const output = renderEventsJsonl(events);
    expect(output.endsWith('\n')).toBe(true);
    const lines = output.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const expectedKeys = ['task_id', 'tool', 'status', 'detail', 'created_at'];
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toBeTypeOf('object');
      expect(Object.keys(JSON.parse(line))).toEqual(expectedKeys);
    }
    expect(JSON.parse(lines[0])).toEqual({ task_id: 'TASK-1', tool: 'claim_work', status: 'success', detail: 'started', created_at: '2026-10-20T01:00:00Z' });
    expect(JSON.parse(lines[1])).toEqual({ task_id: null, tool: 'handoff', status: 'error', detail: null, created_at: '2026-10-20T02:00:00Z' });
  });
});
