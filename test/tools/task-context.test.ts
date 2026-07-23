import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleGetTaskContext } from '../../src/tools/get-task-context.js';
import { handleHandoff } from '../../src/tools/handoff.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';

describe('task-scoped memory', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    handleClaimWork(repos, {
      task_id: 'TASK-12',
      title: 'Retry payments',
      agent: 'claude-code',
      modules: ['billing'],
      expected_files: ['src/billing/retry.ts'],
    });
  });

  it('appends ordered typed updates and defaults to the claiming agent', () => {
    handleUpdateTask(repos, {
      task_id: 'TASK-12',
      kind: 'intent',
      content: 'Do not block checkout',
    });
    handleUpdateTask(repos, {
      task_id: 'TASK-12',
      kind: 'decision',
      content: 'Use a queued retry',
      agent: 'codex',
    });

    const context = handleGetTaskContext(repos, { task_id: 'TASK-12' });
    expect(context.updates.map((update) => update.kind)).toEqual(['intent', 'decision']);
    expect(context.updates.map((update) => update.agent)).toEqual(['claude-code', 'codex']);
    expect(repos.events.listByTask('TASK-12').map((event) => event.tool)).toEqual([
      'claim_work',
      'update_task',
      'update_task',
    ]);
  });

  it('returns live overlaps and the latest handoff and review evidence', () => {
    handleClaimWork(repos, {
      task_id: 'TASK-14',
      title: 'Invoice totals',
      modules: ['billing'],
    });
    expect(handleGetTaskContext(repos, { task_id: 'TASK-12' }).overlaps[0]?.taskId).toBe('TASK-14');

    handleHandoff(repos, {
      task_id: 'TASK-12',
      status: 'done',
      what_changed: 'Queued retries',
      tests_run: ['pnpm test'],
      ready_for_review: true,
    });
    const context = handleGetTaskContext(repos, { task_id: 'TASK-12' });
    expect(context.latestHandoff?.whatChanged).toBe('Queued retries');
    expect(context.latestReview?.planSummary).toBe('Queued retries');
    expect(context.task.status).toBe('review_ready');
    expect(context.overlaps).toEqual([]);
  });

  it('requires an existing claimed task', () => {
    expect(() =>
      handleUpdateTask(repos, {
        task_id: 'MISSING',
        kind: 'progress',
        content: 'Started',
      }),
    ).toThrow(/claim_work/);
    expect(() => handleGetTaskContext(repos, { task_id: 'MISSING' })).toThrow(/claim_work/);
  });
});
