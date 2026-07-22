import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import {
  formatClaimWorkText,
  handleClaimWork,
  toClaimWorkStructured,
} from '../../src/tools/claim-work.js';

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
    expect(formatClaimWorkText(result)).toContain('Potential overlaps (1 of 1 active task(s))');
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

  it('makes an empty result explicitly point-in-time rather than definitive', () => {
    // First claim: nobody else is active, so there is nothing to compare against.
    const first = handleClaimWork(repos, { task_id: 'TASK-1', title: 'Solo' });
    expect(first.checkedAgainst).toBe(0);
    const firstText = formatClaimWorkText(first);
    expect(firstText).not.toContain('No potential overlaps with active tasks.');
    expect(firstText).toContain('No other active claims to check against yet');
    expect(firstText).toContain('concord status');

    // Second, non-overlapping claim: compared against 1 active task, still clean,
    // but the wording stays point-in-time.
    const second = handleClaimWork(repos, {
      task_id: 'TASK-2',
      title: 'Unrelated',
      modules: ['signup'],
    });
    expect(second.overlaps).toEqual([]);
    expect(second.checkedAgainst).toBe(1);
    const secondText = formatClaimWorkText(second);
    expect(secondText).toContain('No overlaps with the 1 other active task(s) at claim time');
    expect(secondText).toContain('point-in-time');
    expect(secondText).toContain('concord status');
  });

  it('does not nudge a well-scoped claim', () => {
    const result = handleClaimWork(repos, {
      task_id: 'TASK-1',
      title: 'Small',
      modules: ['billing'],
      expected_files: ['src/billing/retry.ts'],
    });
    expect(result.breadthReasons).toEqual([]);
    expect(formatClaimWorkText(result)).not.toContain('Heads-up');
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
    const text = formatClaimWorkText(result);
    expect(text).toContain('Heads-up: this claim looks broad');
    expect(text).toContain('independently-handoffable');
  });

  it('shows the breadth nudge alongside overlaps', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Other', modules: ['app-shell'] });
    const result = handleClaimWork(repos, {
      task_id: 'BIG',
      title: 'Big overlapping claim',
      modules: ['app-shell', 'todo-ui', 'client-state', 'api-client'],
    });
    const text = formatClaimWorkText(result);
    expect(text).toContain('Potential overlaps');
    expect(text).toContain('Heads-up: this claim looks broad');
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
    expect(formatClaimWorkText(again)).toContain('Extended claim scope');
  });

  it('re-claiming with no new scope adds nothing', () => {
    handleClaimWork(repos, { task_id: 'T', title: 'FE', modules: ['app-shell'] });
    const again = handleClaimWork(repos, { task_id: 'T', title: 'FE', modules: ['app-shell'] });
    expect(again.scopeAdded).toEqual([]);
    expect(formatClaimWorkText(again)).not.toContain('Extended claim scope');
  });

  it('recomputes overlaps against the merged scope on re-claim', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Owns api', modules: ['api-client'] });
    const first = handleClaimWork(repos, { task_id: 'MINE', title: 'FE', modules: ['app-shell'] });
    expect(first.overlaps).toEqual([]);
    // Re-claim adds the module OTHER owns — the overlap must now surface.
    const again = handleClaimWork(repos, { task_id: 'MINE', title: 'FE', modules: ['api-client'] });
    expect(again.overlaps.some((overlap) => overlap.taskId === 'OTHER')).toBe(true);
  });

  it('emits internally-consistent snake_case structured output', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Owns', modules: ['billing'] });
    const result = handleClaimWork(repos, { task_id: 'MINE', title: 'Mine', modules: ['billing'] });
    const structured = toClaimWorkStructured(result);
    expect(structured.overlaps[0]?.task_id).toBe('OTHER');
    expect(Object.keys(structured)).toEqual(
      expect.arrayContaining(['task_id', 'already_claimed', 'checked_against', 'scope_added']),
    );
    // No camelCase leak inside the overlap entries.
    expect(JSON.stringify(structured)).not.toContain('taskId');
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
    expect(toClaimWorkStructured(child).parent_task_id).toBe('FE-1');
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
