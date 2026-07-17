import { describe, expect, it } from 'vitest';

import type { TaskRecord } from '../../src/db/index.js';
import { detectOverlaps, type OverlapSurface } from '../../src/domain/overlap.js';

function task(partial: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    taskId: partial.taskId,
    title: partial.title ?? partial.taskId,
    owner: null,
    agent: null,
    branch: null,
    worktree: null,
    expectedFiles: partial.expectedFiles ?? [],
    modules: partial.modules ?? [],
    domains: partial.domains ?? [],
    riskTags: partial.riskTags ?? [],
    notes: null,
    status: partial.status ?? 'active',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

const candidate: OverlapSurface = {
  taskId: 'TASK-A',
  expectedFiles: ['src/billing/retry.ts'],
  modules: ['billing', 'stripe'],
  domains: ['payments'],
  riskTags: ['payment-flow'],
};

describe('detectOverlaps', () => {
  it('flags a shared module and directory (the plan demo case)', () => {
    const warnings = detectOverlaps(candidate, [
      task({
        taskId: 'TASK-B',
        title: 'Invoices',
        expectedFiles: ['src/billing/invoices.ts'],
        modules: ['billing'],
      }),
    ]);
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning?.taskId).toBe('TASK-B');
    expect(warning?.reasons).toContain('shared module(s): billing');
    expect(warning?.reasons).toContain('same directory: src/billing');
  });

  it('flags an exact same-file overlap and omits the directory reason', () => {
    const warnings = detectOverlaps(candidate, [
      task({ taskId: 'TASK-C', expectedFiles: ['src/billing/retry.ts'] }),
    ]);
    expect(warnings[0]?.reasons).toContain('same file(s): src/billing/retry.ts');
    expect(warnings[0]?.reasons.some((r) => r.startsWith('same directory'))).toBe(false);
  });

  it('flags shared domains and risk tags', () => {
    const warnings = detectOverlaps(candidate, [
      task({ taskId: 'TASK-D', domains: ['payments'], riskTags: ['payment-flow'] }),
    ]);
    expect(warnings[0]?.reasons).toContain('shared domain(s): payments');
    expect(warnings[0]?.reasons).toContain('shared risk tag(s): payment-flow');
  });

  it('returns nothing for disjoint tasks', () => {
    expect(
      detectOverlaps(candidate, [
        task({ taskId: 'TASK-E', expectedFiles: ['src/signup/page.tsx'], modules: ['signup'] }),
      ]),
    ).toEqual([]);
  });

  it('never flags a task against itself', () => {
    expect(detectOverlaps(candidate, [task({ taskId: 'TASK-A', modules: ['billing'] })])).toEqual(
      [],
    );
  });
});
