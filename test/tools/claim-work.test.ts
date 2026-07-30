import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

describe('handleClaimWork', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('creates a task, records an event, and reports no overlap on first claim', () => {
    const result = handleClaimWork(repos, {
      task_id: 'TASK-12',
      title: 'Add Stripe retry handling',
      modules: ['billing', 'stripe'],
      expected_files: ['src/billing/retry.ts'],
    });
    expect(result.alreadyClaimed).toBe(false);
    expect(result.overlaps).toEqual([]);
    expect(result.checkedAgainst).toBe(0);
    expect(repos.tasks.get('TASK-12')?.title).toBe('Add Stripe retry handling');
    expect(repos.events.listByTask('TASK-12').map((e) => e.tool)).toEqual(['claim_work']);
  });

  it('flags an overlap when a second agent claims the same module', () => {
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry', modules: ['billing'] });
    const result = handleClaimWork(repos, {
      task_id: 'TASK-14',
      title: 'Invoices',
      modules: ['billing'],
    });
    expect(result.overlaps).toHaveLength(1);
    expect(result.overlaps[0]?.taskId).toBe('TASK-12');
    expect(result.checkedAgainst).toBe(1);
  });

  it('is idempotent: re-claiming returns the existing task without duplicating', () => {
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry', modules: ['billing'] });
    const again = handleClaimWork(repos, {
      task_id: 'TASK-12',
      title: 'Retry again',
      modules: ['billing'],
    });
    expect(again.alreadyClaimed).toBe(true);
    expect(again.task.title).toBe('Retry');
    expect(repos.tasks.list()).toHaveLength(1);
  });

  it('rejects re-claiming scope owned by another registered agent', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:one', kind: 'codex' });
    handleRegisterAgent(repos, { agent_id: 'codex:two', kind: 'codex' });
    handleClaimWork(repos, {
      task_id: 'TASK-OWNED',
      title: 'Owned',
      agent_id: 'codex:one',
    });

    expect(() =>
      handleClaimWork(repos, {
        task_id: 'TASK-OWNED',
        title: 'Take over',
        agent_id: 'codex:two',
        modules: ['new-scope'],
      }),
    ).toThrow(/transfer_work/u);
    expect(repos.tasks.get('TASK-OWNED')?.modules).toEqual([]);
  });

  it('ignores non-active tasks when detecting overlaps', () => {
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry', modules: ['billing'] });
    repos.tasks.updateStatus('TASK-12', 'review_ready');
    const result = handleClaimWork(repos, {
      task_id: 'TASK-14',
      title: 'Invoices',
      modules: ['billing'],
    });
    expect(result.overlaps).toEqual([]);
  });

  it('reports how many active tasks the point-in-time overlap check considered', () => {
    // First claim: nobody else is active, so there is nothing to compare against.
    const first = handleClaimWork(repos, { task_id: 'TASK-1', title: 'Solo' });
    expect(first.checkedAgainst).toBe(0);

    // Second, non-overlapping claim: compared against 1 active task, still clean,
    // but the wording stays point-in-time.
    const second = handleClaimWork(repos, {
      task_id: 'TASK-2',
      title: 'Unrelated',
      modules: ['signup'],
    });
    expect(second.overlaps).toEqual([]);
    expect(second.checkedAgainst).toBe(1);
  });

  it('does not nudge a well-scoped claim', () => {
    const result = handleClaimWork(repos, {
      task_id: 'TASK-1',
      title: 'Small',
      modules: ['billing'],
      expected_files: ['src/billing/retry.ts'],
    });
    expect(result.breadthReasons).toEqual([]);
  });

  it('nudges an oversized claim to split, without blocking it', () => {
    const result = handleClaimWork(repos, {
      task_id: 'TODO-FRONTEND-001',
      title: 'Build the whole frontend',
      modules: ['app-shell', 'todo-ui', 'client-state', 'api-client'],
      domains: ['frontend', 'todo', 'auth'],
      expected_files: ['a.tsx', 'b.tsx', 'c.tsx', 'd.tsx', 'e.tsx', 'f.tsx'],
    });
    // The claim still succeeds (non-blocking) ...
    expect(result.alreadyClaimed).toBe(false);
    expect(repos.tasks.get('TODO-FRONTEND-001')).toBeDefined();
    // ... but it surfaces a decomposition suggestion.
    expect(result.breadthReasons.length).toBeGreaterThan(0);
  });

  it('shows the breadth nudge alongside overlaps', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Other', modules: ['app-shell'] });
    const result = handleClaimWork(repos, {
      task_id: 'BIG',
      title: 'Big overlapping claim',
      modules: ['app-shell', 'todo-ui', 'client-state', 'api-client'],
    });
    expect(result.overlaps).toHaveLength(1);
    expect(result.breadthReasons.length).toBeGreaterThan(0);
  });

  it('extends scope on re-claim, persists the union, and reports what was added', () => {
    handleClaimWork(repos, {
      task_id: 'T',
      title: 'FE',
      modules: ['app-shell'],
      expected_files: ['app/page.tsx'],
    });
    const again = handleClaimWork(repos, {
      task_id: 'T',
      title: 'FE',
      modules: ['app-shell', 'api-client'],
      expected_files: ['lib/api.ts'],
    });
    expect(again.alreadyClaimed).toBe(true);
    expect(again.scopeAdded).toContain('module: api-client');
    expect(again.scopeAdded).toContain('file: lib/api.ts');
    // Persisted as a union, not a replacement or a duplicate.
    const stored = repos.tasks.get('T');
    expect(stored?.modules).toEqual(['app-shell', 'api-client']);
    expect(stored?.expectedFiles).toEqual(['app/page.tsx', 'lib/api.ts']);
    expect(repos.tasks.list()).toHaveLength(1);
  });

  it('re-claiming with no new scope adds nothing', () => {
    handleClaimWork(repos, { task_id: 'T', title: 'FE', modules: ['app-shell'] });
    const again = handleClaimWork(repos, { task_id: 'T', title: 'FE', modules: ['app-shell'] });
    expect(again.scopeAdded).toEqual([]);
  });

  it('recomputes overlaps against the merged scope on re-claim', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Owns api', modules: ['api-client'] });
    const first = handleClaimWork(repos, { task_id: 'MINE', title: 'FE', modules: ['app-shell'] });
    expect(first.overlaps).toEqual([]);
    // Re-claim adds the module OTHER owns — the overlap must now surface.
    const again = handleClaimWork(repos, { task_id: 'MINE', title: 'FE', modules: ['api-client'] });
    expect(again.overlaps.some((overlap) => overlap.taskId === 'OTHER')).toBe(true);
  });

  it('records a parent task id and does not flag overlaps with its own parent', () => {
    handleClaimWork(repos, { task_id: 'FE-1', title: 'Frontend', modules: ['app-shell'] });
    const child = handleClaimWork(repos, {
      task_id: 'FE-1.1',
      title: 'App shell subtask',
      parent_task_id: 'FE-1',
      modules: ['app-shell'],
    });
    expect(child.task.parentTaskId).toBe('FE-1');
    // Shares a module with its parent, but that is expected — not flagged.
    expect(child.overlaps).toEqual([]);
  });

  it('still flags overlaps between a subtask and unrelated (non-parent) tasks', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Other', modules: ['app-shell'] });
    const child = handleClaimWork(repos, {
      task_id: 'FE-1.1',
      title: 'Sub',
      parent_task_id: 'FE-1',
      modules: ['app-shell'],
    });
    expect(child.overlaps.some((overlap) => overlap.taskId === 'OTHER')).toBe(true);
  });
});
