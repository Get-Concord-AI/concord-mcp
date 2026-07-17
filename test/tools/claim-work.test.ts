import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { formatClaimWorkText, handleClaimWork } from '../../src/tools/claim-work.js';

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
    expect(formatClaimWorkText(result)).toContain('Potential overlaps (1)');
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

  it('formats a no-overlap claim clearly', () => {
    const result = handleClaimWork(repos, { task_id: 'TASK-1', title: 'Solo' });
    expect(formatClaimWorkText(result)).toContain('No potential overlaps');
  });
});
