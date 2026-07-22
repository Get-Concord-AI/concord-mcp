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
});
