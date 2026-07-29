import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { formatHandoffText, handleHandoff } from '../../src/tools/handoff.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

describe('handleHandoff', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('records evidence without transferring ownership or changing task status', () => {
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry', modules: ['billing'] });
    const result = handleHandoff(repos, {
      task_id: 'TASK-12',
      status: 'done',
      what_changed: 'Queued retries instead of synchronous',
      changed_files: ['src/billing/retry.ts'],
      tests_run: ['pnpm test billing'],
      needs_review_from: ['payments-team'],
    });

    expect(result.taskAutoCreated).toBe(false);
    expect(result.handoff.whatChanged).toBe('Queued retries instead of synchronous');
    expect(repos.tasks.get('TASK-12')?.status).toBe('active');
    expect(repos.handoffs.latestForTask('TASK-12')?.status).toBe('done');
    expect(repos.events.listByTask('TASK-12').map((e) => e.tool)).toEqual([
      'claim_work',
      'handoff',
    ]);
  });

  it('rejects evidence for an unclaimed task', () => {
    expect(() =>
      handleHandoff(repos, {
        task_id: 'TASK-99',
        status: 'blocked',
        what_changed: 'Started but blocked on API keys',
      }),
    ).toThrow(/not claimed/u);
  });

  it('formats needs-review recipients', () => {
    handleClaimWork(repos, { task_id: 'TASK-1', title: 'Review recipients' });
    const result = handleHandoff(repos, {
      task_id: 'TASK-1',
      status: 'done',
      what_changed: 'x',
      needs_review_from: ['alex', 'sam'],
    });
    expect(formatHandoffText(result)).toContain('Needs review from: alex, sam');
  });

  it('produces a review packet when ready_for_review is set (folded review_ready)', () => {
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry', modules: ['billing'] });
    const result = handleHandoff(repos, {
      task_id: 'TASK-12',
      status: 'done',
      what_changed: 'Queued retries',
      ready_for_review: true,
      tests_run: ['pnpm test'],
      open_questions: ['Sync or queued?'],
      diff_size: '+40 / -5',
    });

    expect(result.reviewReady).toBe(true);
    // Task is review-ready, and a review record was written from the handoff.
    expect(repos.tasks.get('TASK-12')?.status).toBe('review_ready');
    const review = repos.reviews.latestForTask('TASK-12');
    expect(review?.planSummary).toBe('Queued retries');
    expect(review?.openQuestions).toEqual(['Sync or queued?']);
    expect(review?.diffSize).toBe('+40 / -5');
    // Both handoff and review_ready adoption are recorded.
    expect(repos.events.listByTask('TASK-12').map((e) => e.tool)).toEqual([
      'claim_work',
      'handoff',
      'review_ready',
    ]);
    expect(formatHandoffText(result)).toContain('Marked review-ready');
  });

  it('does not produce a review packet on a plain handoff', () => {
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry' });
    const result = handleHandoff(repos, { task_id: 'TASK-12', status: 'done', what_changed: 'x' });
    expect(result.reviewReady).toBe(false);
    expect(repos.tasks.get('TASK-12')?.status).toBe('active');
    expect(repos.reviews.latestForTask('TASK-12')).toBeUndefined();
  });

  it('prevents an unrelated agent from recording owner evidence', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:owner', kind: 'codex' });
    handleRegisterAgent(repos, { agent_id: 'codex:other', kind: 'codex' });
    handleClaimWork(repos, {
      task_id: 'TASK-OWNED',
      title: 'Owned',
      agent_id: 'codex:owner',
    });
    expect(() =>
      handleHandoff(repos, {
        task_id: 'TASK-OWNED',
        status: 'done',
        what_changed: 'not mine',
        agent_id: 'codex:other',
      }),
    ).toThrow(/current owner/u);
  });

  it('requires the current version for an owned review-ready transition', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:owner', kind: 'codex' });
    handleClaimWork(repos, {
      task_id: 'TASK-REVIEW',
      title: 'Review',
      agent_id: 'codex:owner',
    });
    expect(() =>
      handleHandoff(repos, {
        task_id: 'TASK-REVIEW',
        status: 'done',
        what_changed: 'ready',
        agent_id: 'codex:owner',
        ready_for_review: true,
      }),
    ).toThrow(/expected_version is required/u);
    expect(repos.handoffs.latestForTask('TASK-REVIEW')).toBeUndefined();

    const result = handleHandoff(repos, {
      task_id: 'TASK-REVIEW',
      status: 'done',
      what_changed: 'ready',
      agent_id: 'codex:owner',
      expected_version: 1,
      ready_for_review: true,
    });
    expect(result.reviewReady).toBe(true);
    expect(repos.tasks.get('TASK-REVIEW')?.version).toBe(2);
  });
});
