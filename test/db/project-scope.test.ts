import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { migrations } from '../../src/db/schema.js';

const task = {
  taskId: 'TASK-1',
  title: 'Shared id',
  owner: null,
  agent: null,
  branch: null,
  worktree: null,
  expectedFiles: ['src/index.ts'],
  modules: ['core'],
  domains: [],
  riskTags: [],
  notes: null,
  parentTaskId: null,
  agentId: null,
} as const;

const handoff = {
  taskId: 'TASK-1',
  status: 'done',
  changedFiles: [],
  whatChanged: 'done',
  testsRun: [],
  knownRisks: [],
  assumptions: [],
  decisions: [],
  guardrailsChecked: [],
  needsReviewFrom: [],
  nextSteps: [],
} as const;

/** One store holding a repository's project and the `general` one. */
function twoProjects() {
  const db = openDatabase(':memory:');
  return {
    db,
    repo: createRepositories(db, 'github.com/org/repo'),
    general: createRepositories(db, 'general'),
  };
}

/** A store file left at schema version 11, as Concord 0.12 wrote it. */
function version11Store(): { filename: string; legacy: Database.Database } {
  const filename = join(mkdtempSync(join(tmpdir(), 'concord-012-')), 'concord.db');
  const legacy = new Database(filename);
  migrations.slice(0, 11).forEach((migration, index) => {
    legacy.exec(migration);
    legacy.pragma(`user_version = ${String(index + 1)}`);
  });
  return { filename, legacy };
}

describe('project-scoped stores', () => {
  it('lets two projects in one store reuse a task id without seeing each other', () => {
    const { db, repo, general } = twoProjects();

    repo.tasks.create(task);
    general.tasks.create({ ...task, title: 'Same id, other project' });
    repo.handoffs.create(handoff);
    repo.events.record({ taskId: 'TASK-1', tool: 'claim_work', status: 'success', detail: null });

    expect(repo.tasks.get('TASK-1')?.title).toBe('Shared id');
    expect(general.tasks.get('TASK-1')?.title).toBe('Same id, other project');
    expect(general.tasks.listByStatuses(['active'])).toHaveLength(1);
    expect(general.handoffs.listByTask('TASK-1')).toEqual([]);
    expect(general.events.list()).toEqual([]);
    expect(repo.events.list()).toHaveLength(1);

    const moved = general.tasks.transition({
      taskId: 'TASK-1',
      expectedVersion: 1,
      status: 'closed',
      agentId: null,
      assignedAgentId: null,
      leaseExpiresAt: null,
    });
    expect(moved?.status).toBe('closed');
    expect(repo.tasks.get('TASK-1')?.status).toBe('active');

    // A row for a task that exists only in the other project is refused.
    repo.tasks.create({ ...task, taskId: 'TASK-2' });
    expect(() => general.handoffs.create({ ...handoff, taskId: 'TASK-2' })).toThrow(/FOREIGN KEY/u);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it("keeps each project's task history to itself", () => {
    const { repo, general } = twoProjects();
    const review = { taskId: 'TASK-1', testsRun: [], diffSize: null, guardrailsChecked: [] };
    const reviewRest = { assumptions: [], openQuestions: [], provenance: [] };
    for (const [repos, label] of [
      [repo, 'repo'],
      [general, 'general'],
    ] as const) {
      repos.tasks.create(task);
      repos.reviews.create({ ...review, ...reviewRest, planSummary: label });
      repos.taskUpdates.create({ taskId: 'TASK-1', kind: 'decision', content: label, agent: null });
      repos.ownershipEvents.record({
        taskId: 'TASK-1',
        transition: label,
        actorAgentId: 'codex:a',
        fromAgentId: null,
        toAgentId: null,
        fromStatus: 'active',
        toStatus: 'active',
        fromVersion: 1,
        toVersion: 1,
        reason: null,
      });
    }

    // The general project's review is the newer one in the table.
    expect(repo.reviews.latestForTasks(['TASK-1']).map((r) => r.planSummary)).toEqual(['repo']);
    expect(repo.reviews.latestForTask('TASK-1')?.planSummary).toBe('repo');
    expect(repo.taskUpdates.listByTask('TASK-1').map((u) => u.content)).toEqual(['repo']);
    expect(repo.ownershipEvents.listByTask('TASK-1').map((e) => e.transition)).toEqual(['repo']);

    const offer = { ...handoff, status: 'in_progress', deliveryStatus: 'pending' } as const;
    const foreign = general.handoffs.create(offer);
    expect(repo.handoffs.get(foreign.id)).toBeUndefined();
    expect(repo.handoffs.resolve(foreign.id, 'accepted', null)).toBeUndefined();
    expect(general.handoffs.get(foreign.id)?.deliveryStatus).toBe('pending');
  });

  it('shares agents and messages across projects but scopes a task thread', () => {
    const { db, repo, general } = twoProjects();
    repo.tasks.create(task);
    db.exec(`INSERT INTO agents (agent_id, kind, first_seen, last_seen)
      VALUES ('codex:a', 'codex', 't', 't'), ('codex:b', 'codex', 't', 't')`);

    const message = { replyToMessageId: null, content: 'hello', idempotencyKey: 'k' } as const;
    general.agentMessages.create({
      ...message,
      messageId: 'm1',
      taskId: null,
      senderAgentId: 'codex:b',
      recipientAgentId: 'codex:a',
    });
    repo.agentMessages.create({
      ...message,
      messageId: 'm2',
      taskId: 'TASK-1',
      senderAgentId: 'codex:a',
      recipientAgentId: 'codex:b',
    });

    expect(repo.agents.list().map((entry) => entry.agentId)).toEqual(['codex:a', 'codex:b']);
    expect(repo.agentMessages.listByAgent('codex:a').map((m) => m.messageId)).toEqual(['m1', 'm2']);
    expect(repo.agentMessages.listByTask('TASK-1').map((m) => m.messageId)).toEqual(['m2']);
    expect(general.agentMessages.listByTask('TASK-1')).toEqual([]);
  });

  it('upgrades a version-11 store into the local project without losing rows', () => {
    const { filename, legacy } = version11Store();
    // Plain SQL: today's repositories write a column version 11 does not have.
    legacy.exec(`
      INSERT INTO tasks (task_id, title, status, created_at, updated_at)
        VALUES ('TASK-1', 'Legacy', 'active', '2026-01-01', '2026-01-01');
      INSERT INTO handoffs (task_id, status, what_changed, created_at)
        VALUES ('TASK-1', 'done', 'legacy', '2026-01-01');
      INSERT INTO events (task_id, tool, status, created_at)
        VALUES ('TASK-1', 'claim_work', 'success', '2026-01-01');
    `);
    legacy.close();

    const upgraded = createRepositories(openDatabase(filename));
    expect(upgraded.db.pragma('user_version', { simple: true })).toBe(13);
    // Found through the local project, so every copied row was put in it.
    expect(upgraded.tasks.get('TASK-1')?.title).toBe('Legacy');
    expect(upgraded.handoffs.listByTask('TASK-1').map((entry) => entry.whatChanged)).toEqual([
      'legacy',
    ]);
    expect(upgraded.events.list()).toHaveLength(1);

    // Autoincrement ids continue past the copied rows.
    const next = upgraded.handoffs.create(handoff);
    expect(next.id).toBe(2);
  });

  it('rolls back a migration that fails part-way, keeping the previous schema', () => {
    const { filename, legacy } = version11Store();
    // Occupy a name the rebuild needs only after its first table is replaced.
    legacy.exec('CREATE TABLE handoffs_012 (id INTEGER)');
    legacy.close();

    expect(() => openDatabase(filename)).toThrow(/handoffs_012/u);

    const after = new Database(filename);
    expect(after.pragma('user_version', { simple: true })).toBe(11);
    const projectColumns = "SELECT count(*) FROM pragma_table_info('tasks') WHERE name = 'project'";
    expect(after.prepare(projectColumns).pluck().get()).toBe(0);
    after.close();
  });
});
