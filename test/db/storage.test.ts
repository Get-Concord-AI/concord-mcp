import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';

function newRepos(): Repositories {
  return createRepositories(openDatabase(':memory:'));
}

const baseTask = {
  taskId: 'TASK-12',
  title: 'Add Stripe retry handling',
  owner: 'alex',
  agent: 'claude-code',
  branch: 'feat/billing-retry',
  worktree: null,
  expectedFiles: ['src/billing/retry.ts'],
  modules: ['billing', 'stripe'],
  domains: ['payments'],
  riskTags: ['payment-flow'],
  notes: null,
  parentTaskId: null,
} as const;

describe('migrations', () => {
  it('applies migrations and creates the core tables', () => {
    const { db } = newRepos();
    const raw: unknown = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    const rows = z.array(z.object({ name: z.string() })).parse(raw);
    const names = new Set(rows.map((row) => row.name));
    expect(names.has('tasks')).toBe(true);
    expect(names.has('handoffs')).toBe(true);
    expect(names.has('events')).toBe(true);
  });

  it('is idempotent when reopening (user_version already at head)', () => {
    const { db } = newRepos();
    const version: unknown = db.pragma('user_version', { simple: true });
    expect(version).toBe(3);
  });
});

describe('task repository', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = newRepos();
  });

  it('creates and reads back a task with array fields intact', () => {
    const created = repos.tasks.create(baseTask);
    expect(created.taskId).toBe('TASK-12');
    expect(created.modules).toEqual(['billing', 'stripe']);
    expect(created.status).toBe('active');

    const fetched = repos.tasks.get('TASK-12');
    expect(fetched?.expectedFiles).toEqual(['src/billing/retry.ts']);
    expect(fetched?.owner).toBe('alex');
    expect(fetched?.worktree).toBeNull();
  });

  it('returns undefined for a missing task', () => {
    expect(repos.tasks.get('NOPE')).toBeUndefined();
  });

  it('lists tasks in insertion order', () => {
    repos.tasks.create(baseTask);
    repos.tasks.create({ ...baseTask, taskId: 'TASK-14', title: 'Signup copy' });
    expect(repos.tasks.list().map((t) => t.taskId)).toEqual(['TASK-12', 'TASK-14']);
  });

  it('updates status', () => {
    repos.tasks.create(baseTask);
    const updated = repos.tasks.updateStatus('TASK-12', 'review_ready');
    expect(updated?.status).toBe('review_ready');
  });

  it('updates scope (files/modules/domains/risk tags)', () => {
    repos.tasks.create(baseTask);
    const updated = repos.tasks.updateScope('TASK-12', {
      expectedFiles: ['src/a.ts', 'src/b.ts'],
      modules: ['billing', 'stripe'],
      domains: ['payments'],
      riskTags: ['payment-flow'],
    });
    expect(updated?.expectedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(updated?.modules).toEqual(['billing', 'stripe']);
    expect(repos.tasks.get('TASK-12')?.domains).toEqual(['payments']);
  });

  it('persists a parent task id (null for top-level tasks)', () => {
    repos.tasks.create({ ...baseTask, taskId: 'PARENT' });
    repos.tasks.create({ ...baseTask, taskId: 'CHILD', parentTaskId: 'PARENT' });
    expect(repos.tasks.get('CHILD')?.parentTaskId).toBe('PARENT');
    expect(repos.tasks.get('PARENT')?.parentTaskId).toBeNull();
  });
});

describe('handoff repository', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = newRepos();
    repos.tasks.create(baseTask);
  });

  it('records a handoff and reads it back', () => {
    const handoff = repos.handoffs.create({
      taskId: 'TASK-12',
      status: 'done',
      changedFiles: ['src/billing/retry.ts'],
      whatChanged: 'Queued retries instead of synchronous',
      testsRun: ['pnpm test billing'],
      knownRisks: [],
      assumptions: ['retries are idempotent'],
      decisions: ['use a queue'],
      guardrailsChecked: ['stripe payment test'],
      needsReviewFrom: ['payments-team'],
      nextSteps: [],
    });
    expect(handoff.id).toBeGreaterThan(0);
    expect(handoff.assumptions).toEqual(['retries are idempotent']);
  });

  it('returns the latest handoff for a task', () => {
    const common = {
      taskId: 'TASK-12',
      changedFiles: [],
      testsRun: [],
      knownRisks: [],
      assumptions: [],
      decisions: [],
      guardrailsChecked: [],
      needsReviewFrom: [],
      nextSteps: [],
    };
    repos.handoffs.create({ ...common, status: 'blocked', whatChanged: 'first' });
    repos.handoffs.create({ ...common, status: 'done', whatChanged: 'second' });
    expect(repos.handoffs.latestForTask('TASK-12')?.whatChanged).toBe('second');
    expect(repos.handoffs.listByTask('TASK-12')).toHaveLength(2);
  });

  it('rejects a handoff for an unknown task (foreign key)', () => {
    expect(() =>
      repos.handoffs.create({
        taskId: 'MISSING',
        status: 'done',
        changedFiles: [],
        whatChanged: 'x',
        testsRun: [],
        knownRisks: [],
        assumptions: [],
        decisions: [],
        guardrailsChecked: [],
        needsReviewFrom: [],
        nextSteps: [],
      }),
    ).toThrow();
  });
});

describe('event repository', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = newRepos();
    repos.tasks.create(baseTask);
  });

  it('records events and lists them by task', () => {
    repos.events.record({ taskId: 'TASK-12', tool: 'claim_work', status: 'success', detail: null });
    repos.events.record({ taskId: 'TASK-12', tool: 'handoff', status: 'success', detail: 'ok' });
    repos.events.record({ taskId: null, tool: 'review_ready', status: 'error', detail: 'no task' });

    expect(repos.events.list()).toHaveLength(3);
    const forTask = repos.events.listByTask('TASK-12');
    expect(forTask.map((e) => e.tool)).toEqual(['claim_work', 'handoff']);
  });
});
