import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, openRepositories, type Repositories } from '../../src/db/index.js';

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
  agentId: null,
} as const;

const baseAgent = {
  agentId: 'claude-code:7p8v',
  kind: 'claude-code',
  owner: 'alex',
  model: 'opus-4.8',
  pid: 4242,
  cwd: '/repo',
  worktree: null,
  branch: 'feat/x',
  summary: 'building the todo frontend',
  status: 'active',
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
    expect(names.has('task_updates')).toBe(true);
    expect(names.has('agents')).toBe(true);
    expect(names.has('task_ownership_events')).toBe(true);
    expect(names.has('agent_endpoints')).toBe(true);
    expect(names.has('agent_messages')).toBe(true);
    expect(names.has('agent_message_events')).toBe(true);
  });

  it('is idempotent when reopening (user_version already at head)', () => {
    const { db } = newRepos();
    const version: unknown = db.pragma('user_version', { simple: true });
    expect(version).toBe(13);
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
    expect(created.version).toBe(1);
    expect(created.assignedAgentId).toBeNull();

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
    expect(updated?.version).toBe(2);
  });

  it('transitions ownership with compare-and-swap semantics', () => {
    repos.tasks.create(baseTask);
    const accepted = repos.tasks.transition({
      taskId: 'TASK-12',
      expectedVersion: 1,
      status: 'active',
      agentId: 'codex:one',
      assignedAgentId: null,
      leaseExpiresAt: null,
    });
    const stale = repos.tasks.transition({
      taskId: 'TASK-12',
      expectedVersion: 1,
      status: 'active',
      agentId: 'codex:two',
      assignedAgentId: null,
      leaseExpiresAt: null,
    });

    expect(accepted?.agentId).toBe('codex:one');
    expect(accepted?.version).toBe(2);
    expect(stale).toBeUndefined();
    expect(repos.tasks.get('TASK-12')?.agentId).toBe('codex:one');
  });

  it('allows only one transition across two database connections', () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'concord-cas-')), 'concord.db');
    const first = openRepositories(filename);
    const second = openRepositories(filename);
    first.tasks.create(baseTask);
    expect(second.tasks.get('TASK-12')?.version).toBe(1);

    const winner = first.tasks.transition({
      taskId: 'TASK-12',
      expectedVersion: 1,
      status: 'active',
      agentId: 'codex:first',
      assignedAgentId: null,
      leaseExpiresAt: null,
    });
    const loser = second.tasks.transition({
      taskId: 'TASK-12',
      expectedVersion: 1,
      status: 'active',
      agentId: 'codex:second',
      assignedAgentId: null,
      leaseExpiresAt: null,
    });

    expect(winner?.version).toBe(2);
    expect(loser).toBeUndefined();
    expect(second.tasks.get('TASK-12')?.agentId).toBe('codex:first');
    first.db.close();
    second.db.close();
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

  it('refreshes task activity without changing its lifecycle version', () => {
    repos.tasks.create(baseTask);
    const oldTimestamp = '2026-01-01T00:00:00.000Z';
    repos.db
      .prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?')
      .run(oldTimestamp, 'TASK-12');

    const touched = repos.tasks.touchActivity('TASK-12');

    expect(touched?.updatedAt).not.toBe(oldTimestamp);
    expect(touched).toMatchObject({ version: 1, status: 'active' });
    expect(touched?.expectedFiles).toEqual(baseTask.expectedFiles);
    expect(repos.tasks.touchActivity('MISSING')).toBeUndefined();
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
    expect(handoff.deliveryStatus).toBe('recorded');
  });

  it('records and conditionally resolves a pending handoff delivery', () => {
    const pending = repos.handoffs.create({
      taskId: 'TASK-12',
      status: 'in_progress',
      changedFiles: [],
      whatChanged: 'ready for the next agent',
      testsRun: [],
      knownRisks: [],
      assumptions: [],
      decisions: [],
      guardrailsChecked: [],
      needsReviewFrom: [],
      nextSteps: [],
      fromAgentId: 'codex:one',
      toAgentId: 'codex:two',
      deliveryStatus: 'pending',
      taskVersion: 2,
    });

    expect(repos.handoffs.pendingForTask('TASK-12')?.id).toBe(pending.id);
    expect(repos.handoffs.resolve(pending.id, 'accepted', null)?.deliveryStatus).toBe('accepted');
    expect(repos.handoffs.resolve(pending.id, 'declined', 'late')).toBeUndefined();
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

describe('ownership event repository', () => {
  it('records an append-only ownership transition', () => {
    const repos = newRepos();
    repos.tasks.create(baseTask);
    const event = repos.ownershipEvents.record({
      taskId: 'TASK-12',
      transition: 'assign',
      actorAgentId: 'supervisor:one',
      fromAgentId: null,
      toAgentId: 'codex:two',
      fromStatus: 'active',
      toStatus: 'assigned',
      fromVersion: 1,
      toVersion: 2,
      reason: 'route to specialist',
    });

    expect(event.toAgentId).toBe('codex:two');
    expect(repos.ownershipEvents.listByTask('TASK-12')).toEqual([event]);
  });
});

describe('agent repository', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = newRepos();
  });

  it('registers an agent and reads it back with fields intact', () => {
    const created = repos.agents.upsert(baseAgent);
    expect(created.agentId).toBe('claude-code:7p8v');
    expect(created.kind).toBe('claude-code');
    expect(created.pid).toBe(4242);
    expect(created.worktree).toBeNull();
    expect(created.status).toBe('active');
    expect(created.firstSeen).toBe(created.lastSeen);

    const fetched = repos.agents.get('claude-code:7p8v');
    expect(fetched?.summary).toBe('building the todo frontend');
  });

  it('returns undefined for an unknown agent', () => {
    expect(repos.agents.get('nope')).toBeUndefined();
    expect(repos.agents.heartbeat('nope')).toBeUndefined();
    expect(repos.agents.recordActivity('nope')).toBeUndefined();
  });

  it('re-registration preserves first_seen but refreshes mutable fields', () => {
    const first = repos.agents.upsert(baseAgent);
    const updated = repos.agents.upsert({
      ...baseAgent,
      summary: 'now reviewing the PR',
      status: 'waiting_review',
    });
    expect(updated.firstSeen).toBe(first.firstSeen);
    expect(updated.summary).toBe('now reviewing the PR');
    expect(updated.status).toBe('waiting_review');
    expect(repos.agents.list()).toHaveLength(1);
  });

  it('a field-less re-registration keeps every stored field (patch semantics)', () => {
    repos.agents.upsert({ ...baseAgent, worktree: '/repo-wt' });
    const refreshed = repos.agents.upsert({ agentId: 'claude-code:7p8v', kind: 'claude-code' });
    expect(refreshed.owner).toBe('alex');
    expect(refreshed.model).toBe('opus-4.8');
    expect(refreshed.pid).toBe(4242);
    expect(refreshed.cwd).toBe('/repo');
    expect(refreshed.worktree).toBe('/repo-wt');
    expect(refreshed.branch).toBe('feat/x');
    expect(refreshed.summary).toBe('building the todo frontend');
    expect(refreshed.status).toBe('active');
  });

  it('a summary-and-status-only refresh preserves cwd, worktree, owner, model and pid', () => {
    repos.agents.upsert({ ...baseAgent, worktree: '/repo-wt' });
    const refreshed = repos.agents.upsert({
      agentId: 'claude-code:7p8v',
      kind: 'claude-code',
      summary: 'now reviewing',
      status: 'waiting_review',
    });
    expect(refreshed.summary).toBe('now reviewing');
    expect(refreshed.status).toBe('waiting_review');
    expect([refreshed.owner, refreshed.model, refreshed.pid]).toEqual(['alex', 'opus-4.8', 4242]);
    expect([refreshed.cwd, refreshed.worktree]).toEqual(['/repo', '/repo-wt']);
  });

  it('an explicit null clears a field while the others stay', () => {
    repos.agents.upsert({ ...baseAgent, worktree: '/repo-wt' });
    const cleared = repos.agents.upsert({
      agentId: 'claude-code:7p8v',
      kind: 'claude-code',
      worktree: null,
      pid: null,
      summary: null,
    });
    expect(cleared.worktree).toBeNull();
    expect(cleared.pid).toBeNull();
    expect(cleared.summary).toBeNull();
    expect(cleared.summaryUpdatedAt).toBeNull();
    expect([cleared.owner, cleared.cwd, cleared.model]).toEqual(['alex', '/repo', 'opus-4.8']);
  });

  it('a new agent defaults to active and executing', () => {
    const created = repos.agents.upsert({ agentId: 'codex:one', kind: 'codex' });
    expect(created.status).toBe('active');
    expect(created.executionStatus).toBe('executing');
    expect(created.owner).toBeNull();
    expect(created.activityAt).toBeNull();
    expect(created.summaryUpdatedAt).toBeNull();
  });

  it('records heartbeat, activity and summary change as separate timestamps', () => {
    const t0 = '2026-07-24T10:00:00.000Z';
    const t1 = '2026-07-24T10:05:00.000Z';
    const t2 = '2026-07-24T10:09:00.000Z';
    const created = repos.agents.upsert(baseAgent, t0);
    expect([created.heartbeatAt, created.lastSeen, created.firstSeen]).toEqual([t0, t0, t0]);
    expect(created.activityAt).toBeNull();
    expect(created.summaryUpdatedAt).toBe(t0);

    const active = repos.agents.recordActivity('claude-code:7p8v', t1);
    expect(active?.activityAt).toBe(t1);
    expect(active?.heartbeatAt).toBe(t0);
    expect(active?.lastSeen).toBe(t1);
    expect(active?.summaryUpdatedAt).toBe(t0);

    const beat = repos.agents.heartbeat('claude-code:7p8v', t2);
    expect(beat?.heartbeatAt).toBe(t2);
    expect(beat?.activityAt).toBe(t1);
    expect(beat?.lastSeen).toBe(t2);
    expect(beat?.firstSeen).toBe(t0);
  });

  it('activity and heartbeat never change the reported status or summary', () => {
    repos.agents.upsert({ ...baseAgent, status: 'done', summary: 'shipped' });
    repos.agents.recordActivity('claude-code:7p8v');
    const beat = repos.agents.heartbeat('claude-code:7p8v');
    expect(beat?.status).toBe('done');
    expect(beat?.executionStatus).toBe('not_executing');
    expect(beat?.summary).toBe('shipped');
  });

  it('moves summary_updated_at only when the summary actually changes', () => {
    const t0 = '2026-07-24T10:00:00.000Z';
    const t1 = '2026-07-24T10:30:00.000Z';
    const t2 = '2026-07-24T11:00:00.000Z';
    repos.agents.upsert(baseAgent, t0);
    const same = repos.agents.upsert(baseAgent, t1);
    expect(same.summaryUpdatedAt).toBe(t0);
    expect(same.heartbeatAt).toBe(t1);
    const omitted = repos.agents.upsert({ agentId: 'claude-code:7p8v', kind: 'claude-code' }, t1);
    expect(omitted.summaryUpdatedAt).toBe(t0);
    const changed = repos.agents.upsert({ ...baseAgent, summary: 'a new task' }, t2);
    expect(changed.summaryUpdatedAt).toBe(t2);
  });

  it('only an explicit status transition changes execution_status', () => {
    repos.agents.upsert({ ...baseAgent, status: 'done' });
    expect(repos.agents.get('claude-code:7p8v')?.executionStatus).toBe('not_executing');
    const omitted = repos.agents.upsert({ agentId: 'claude-code:7p8v', kind: 'claude-code' });
    expect([omitted.status, omitted.executionStatus]).toEqual(['done', 'not_executing']);
    const reactivated = repos.agents.upsert({ ...baseAgent, status: 'active' });
    expect([reactivated.status, reactivated.executionStatus]).toEqual(['active', 'executing']);
    const blocked = repos.agents.upsert({ ...baseAgent, status: 'blocked' });
    expect([blocked.status, blocked.executionStatus]).toEqual(['blocked', 'not_executing']);
  });

  it('lists multiple registered agents', () => {
    repos.agents.upsert(baseAgent);
    repos.agents.upsert({ ...baseAgent, agentId: 'codex:9q2r', kind: 'codex' });
    expect(repos.agents.list().map((a) => a.agentId)).toEqual(['claude-code:7p8v', 'codex:9q2r']);
  });
});
