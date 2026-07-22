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
    parentTaskId: partial.parentTaskId ?? null,
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

  it('flags shared domains and risk tags (reported as normalized tokens)', () => {
    const warnings = detectOverlaps(candidate, [
      task({ taskId: 'TASK-D', domains: ['payments'], riskTags: ['payment-flow'] }),
    ]);
    expect(warnings[0]?.reasons).toContain('shared domain(s): payments');
    // 'payment-flow' tokenizes to {payment, flow}; reasons name the shared tokens.
    expect(warnings[0]?.reasons).toContain('shared risk tag(s): flow, payment');
  });

  it('matches labels across case, whitespace, and word order (the dogfooding miss)', () => {
    // A UX task declared domains as the single phrase "todo frontend"; the
    // implementation task declared ["frontend", "todo"]. Exact matching missed
    // this; token matching catches it.
    const uxCandidate: OverlapSurface = {
      taskId: 'TASK-UX',
      expectedFiles: [],
      modules: ['frontend UX'],
      domains: ['todo frontend'],
      riskTags: [],
    };
    const warnings = detectOverlaps(uxCandidate, [
      task({ taskId: 'TASK-FE', title: 'Frontend', domains: ['Frontend', 'todo'] }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reasons).toContain('shared domain(s): frontend, todo');
  });

  it('treats kebab, snake, and space separators as equivalent for modules', () => {
    const kebab: OverlapSurface = {
      taskId: 'TASK-K',
      expectedFiles: [],
      modules: ['app-shell'],
      domains: [],
      riskTags: [],
    };
    const warnings = detectOverlaps(kebab, [task({ taskId: 'TASK-S', modules: ['app_shell'] })]);
    expect(warnings[0]?.reasons).toContain('shared module(s): app, shell');
  });

  it('normalizes file paths so ./app/page.tsx and app/page.tsx are the same file', () => {
    const withDotSlash: OverlapSurface = {
      taskId: 'TASK-P',
      expectedFiles: ['./app/page.tsx'],
      modules: [],
      domains: [],
      riskTags: [],
    };
    const sameFile = detectOverlaps(withDotSlash, [
      task({ taskId: 'TASK-Q', expectedFiles: ['app/page.tsx'] }),
    ]);
    expect(sameFile[0]?.reasons).toContain('same file(s): app/page.tsx');

    const sameDir = detectOverlaps(withDotSlash, [
      task({ taskId: 'TASK-R', expectedFiles: ['app//layout.tsx'] }),
    ]);
    expect(sameDir[0]?.reasons).toContain('same directory: app');
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

  it('does not flag a task against its own parent or child (but still flags others)', () => {
    const child: OverlapSurface = {
      taskId: 'FE-1.1',
      parentTaskId: 'FE-1',
      expectedFiles: [],
      modules: ['app-shell'],
      domains: [],
      riskTags: [],
    };
    // Shares a module with its parent — expected, so not flagged.
    expect(detectOverlaps(child, [task({ taskId: 'FE-1', modules: ['app-shell'] })])).toEqual([]);
    // The reverse direction (parent candidate vs child) is also excluded.
    const parent: OverlapSurface = {
      taskId: 'FE-1',
      expectedFiles: [],
      modules: ['app-shell'],
      domains: [],
      riskTags: [],
    };
    expect(
      detectOverlaps(parent, [
        task({ taskId: 'FE-1.1', modules: ['app-shell'], parentTaskId: 'FE-1' }),
      ]),
    ).toEqual([]);
    // An unrelated task sharing the module is still flagged.
    expect(detectOverlaps(child, [task({ taskId: 'OTHER', modules: ['app-shell'] })])).toHaveLength(
      1,
    );
  });
});
