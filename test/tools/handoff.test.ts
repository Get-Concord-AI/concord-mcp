import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { formatHandoffText, handleHandoff } from '../../src/tools/handoff.js';

describe('handleHandoff', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('records a handoff for a claimed task and marks it handed off', () => {
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
    expect(repos.tasks.get('TASK-12')?.status).toBe('handed_off');
    expect(repos.handoffs.latestForTask('TASK-12')?.status).toBe('done');
    expect(repos.events.listByTask('TASK-12').map((e) => e.tool)).toEqual([
      'claim_work',
      'handoff',
    ]);
  });

  it('auto-creates a stub task when handing off an unclaimed task', () => {
    const result = handleHandoff(repos, {
      task_id: 'TASK-99',
      status: 'blocked',
      what_changed: 'Started but blocked on API keys',
    });
    expect(result.taskAutoCreated).toBe(true);
    expect(repos.tasks.get('TASK-99')?.status).toBe('handed_off');
    expect(formatHandoffText(result)).toContain('created a stub task');
  });

  it('formats needs-review recipients', () => {
    const result = handleHandoff(repos, {
      task_id: 'TASK-1',
      status: 'done',
      what_changed: 'x',
      needs_review_from: ['alex', 'sam'],
    });
    expect(formatHandoffText(result)).toContain('Needs review from: alex, sam');
  });
});
