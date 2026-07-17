import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { formatReviewReadyText, handleReviewReady } from '../../src/tools/review-ready.js';

describe('handleReviewReady', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('records a review packet and marks the task review-ready', () => {
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry', modules: ['billing'] });
    const result = handleReviewReady(repos, {
      task_id: 'TASK-12',
      plan_summary: 'Queue retries instead of blocking checkout',
      tests_run: ['pnpm test billing', 'pnpm test stripe'],
      diff_size: '+120 / -30',
      guardrails_checked: ['stripe payment test'],
      open_questions: ['notify owner immediately or after final retry?'],
      provenance: [
        { field: 'tests', source: 'command output' },
        { field: 'plan', source: 'agent reported' },
      ],
    });

    expect(result.taskAutoCreated).toBe(false);
    expect(result.review.testsRun).toHaveLength(2);
    expect(result.review.provenance).toEqual([
      { field: 'tests', source: 'command output' },
      { field: 'plan', source: 'agent reported' },
    ]);
    expect(repos.tasks.get('TASK-12')?.status).toBe('review_ready');
    expect(repos.reviews.latestForTask('TASK-12')?.diffSize).toBe('+120 / -30');
    expect(repos.events.listByTask('TASK-12').map((e) => e.tool)).toEqual([
      'claim_work',
      'review_ready',
    ]);
  });

  it('auto-creates a stub task when marking an unclaimed task review-ready', () => {
    const result = handleReviewReady(repos, { task_id: 'TASK-77', plan_summary: 'Small fix' });
    expect(result.taskAutoCreated).toBe(true);
    expect(repos.tasks.get('TASK-77')?.status).toBe('review_ready');
    expect(formatReviewReadyText(result)).toContain('review-ready');
  });

  it('defaults array and diff fields when omitted', () => {
    const result = handleReviewReady(repos, { task_id: 'TASK-1', plan_summary: 'x' });
    expect(result.review.testsRun).toEqual([]);
    expect(result.review.provenance).toEqual([]);
    expect(result.review.diffSize).toBeNull();
  });
});
