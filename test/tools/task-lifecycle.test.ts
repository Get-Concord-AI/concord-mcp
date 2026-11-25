import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { LOCAL_PROJECT } from '../../src/db/project-scope-migration.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleAcceptHandoff, handleOfferHandoff } from '../../src/tools/handoff-lifecycle.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import {
  handleAcceptTask,
  handleAssignTask,
  handleCloseTask,
  handleReassignTask,
  handleReleaseTask,
  handleReopenTask,
} from '../../src/tools/task-lifecycle.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';

describe('versioned task lifecycle', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    handleRegisterAgent(repos, {
      agent_id: 'codex:owner',
      kind: 'codex',
      owner: 'alex',
    });
    handleRegisterAgent(repos, {
      agent_id: 'codex:target',
      kind: 'codex',
      owner: 'sam',
    });
    handleRegisterAgent(repos, {
      agent_id: 'codex:supervisor',
      kind: 'codex',
      owner: 'alex',
    });
    handleClaimWork(repos, {
      task_id: 'TASK-1',
      title: 'Lifecycle',
      owner: 'alex',
      agent_id: 'codex:owner',
    });
  });

  it('separates assignment from acceptance and audits both transitions', () => {
    const assigned = handleAssignTask(repos, {
      task_id: 'TASK-1',
      to_agent_id: 'codex:target',
      agent_id: 'codex:owner',
      expected_version: 1,
    });
    expect(assigned.task.status).toBe('assigned');
    expect(assigned.task.agentId).toBe('codex:owner');
    expect(assigned.task.assignedAgentId).toBe('codex:target');
    expect(assigned.task.version).toBe(2);

    const accepted = handleAcceptTask(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:target',
      expected_version: 2,
    });
    expect(accepted.task.status).toBe('active');
    expect(accepted.task.agentId).toBe('codex:target');
    expect(accepted.task.assignedAgentId).toBeNull();
    expect(accepted.task.version).toBe(3);
    expect(repos.ownershipEvents.listByTask('TASK-1').map((event) => event.transition)).toEqual([
      'assign',
      'accept',
    ]);
  });

  it('allows only one acceptance for an expected version', () => {
    handleAssignTask(repos, {
      task_id: 'TASK-1',
      to_agent_id: 'codex:target',
      agent_id: 'codex:owner',
      expected_version: 1,
    });
    handleAcceptTask(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:target',
      expected_version: 2,
    });

    expect(() =>
      handleAcceptTask(repos, {
        task_id: 'TASK-1',
        agent_id: 'codex:target',
        expected_version: 2,
      }),
    ).toThrow(/version conflict/u);
  });

  it('rejects unknown targets, the wrong recipient, and expired assignments', () => {
    expect(() =>
      handleAssignTask(repos, {
        task_id: 'TASK-1',
        to_agent_id: 'ghost:agent',
        agent_id: 'codex:owner',
        expected_version: 1,
      }),
    ).toThrow(/not registered/u);

    handleAssignTask(
      repos,
      {
        task_id: 'TASK-1',
        to_agent_id: 'codex:target',
        agent_id: 'codex:owner',
        expected_version: 1,
        lease_seconds: 1,
      },
      1_000,
    );
    expect(() =>
      handleAcceptTask(
        repos,
        {
          task_id: 'TASK-1',
          agent_id: 'codex:owner',
          expected_version: 2,
        },
        1_500,
      ),
    ).toThrow(/not assigned/u);
    const expired = handleAcceptTask(
      repos,
      {
        task_id: 'TASK-1',
        agent_id: 'codex:target',
        expected_version: 2,
      },
      2_000,
    );
    expect(expired.ownershipEvent.transition).toBe('expire_assignment');
    expect(expired.task.status).toBe('active');
    expect(expired.task.agentId).toBe('codex:owner');
    expect(expired.task.assignedAgentId).toBeNull();
  });

  it('requires ownership, or a same-human supervisor for forced reassignment', () => {
    expect(() =>
      handleCloseTask(repos, {
        task_id: 'TASK-1',
        agent_id: 'codex:supervisor',
        expected_version: 1,
        reason: 'not the active owner',
      }),
    ).toThrow(/current owner/u);

    expect(() =>
      handleReassignTask(repos, {
        task_id: 'TASK-1',
        to_agent_id: 'codex:target',
        agent_id: 'codex:target',
        expected_version: 1,
        reason: 'take over',
        force: true,
      }),
    ).toThrow(/human owner alex can force-reassign TASK-1\.$/u);

    expect(() =>
      handleReassignTask(repos, {
        task_id: 'TASK-1',
        to_agent_id: 'codex:target',
        agent_id: 'codex:supervisor',
        expected_version: 1,
        reason: 'take over',
      }),
    ).toThrow(/force: true\.$/u);

    const reassigned = handleReassignTask(repos, {
      task_id: 'TASK-1',
      to_agent_id: 'codex:target',
      agent_id: 'codex:supervisor',
      expected_version: 1,
      reason: 'owner requested reassignment',
      force: true,
    });
    expect(reassigned.task.status).toBe('assigned');
    expect(reassigned.ownershipEvent.transition).toBe('force_reassign');
    expect(reassigned.ownershipEvent.reason).toBe('owner requested reassignment');
  });

  it('allows forced reassignment of tasks without a human owner only once the holder is inactive', () => {
    handleRegisterAgent(repos, { agent_id: 'claude-code:stale', kind: 'claude-code' });
    handleRegisterAgent(repos, { agent_id: 'codex:peer', kind: 'codex' });
    handleClaimWork(repos, {
      task_id: 'TASK-UNOWNED',
      title: 'Default claim without owner',
      agent_id: 'claude-code:stale',
    });

    // Rejects takeover while the holder is still live or idle.
    expect(() =>
      handleReassignTask(repos, {
        task_id: 'TASK-UNOWNED',
        to_agent_id: 'codex:peer',
        agent_id: 'codex:peer',
        expected_version: 1,
        reason: 'premature takeover',
        force: true,
      }),
    ).toThrow(/while its session is still active\.$/u);

    const idleNow = Date.now() + 10 * 60 * 1000;
    expect(() =>
      handleReassignTask(
        repos,
        {
          task_id: 'TASK-UNOWNED',
          to_agent_id: 'codex:peer',
          agent_id: 'codex:peer',
          expected_version: 1,
          reason: 'still only idle',
          force: true,
        },
        idleNow,
      ),
    ).toThrow(/while its session is still active\.$/u);

    // Once the holder ages into away/archived, non-forced reassign still hints force: true,
    // and force: true succeeds with an audited force_reassign transition.
    const archivedNow = Date.now() + 70 * 60 * 1000;
    expect(() =>
      handleReassignTask(
        repos,
        {
          task_id: 'TASK-UNOWNED',
          to_agent_id: 'codex:peer',
          agent_id: 'codex:peer',
          expected_version: 1,
          reason: 'missing force flag',
        },
        archivedNow,
      ),
    ).toThrow(/force: true\.$/u);

    // Human-owned tasks still reject unrelated actors even when their agent is archived.
    expect(() =>
      handleReassignTask(
        repos,
        {
          task_id: 'TASK-1',
          to_agent_id: 'codex:target',
          agent_id: 'codex:target',
          expected_version: 1,
          reason: 'different human owner',
          force: true,
        },
        archivedNow,
      ),
    ).toThrow(/human owner alex can force-reassign TASK-1\.$/u);

    const recovered = handleReassignTask(
      repos,
      {
        task_id: 'TASK-UNOWNED',
        to_agent_id: 'codex:peer',
        agent_id: 'codex:peer',
        expected_version: 1,
        reason: 'Previous owner inactive',
        force: true,
      },
      archivedNow,
    );
    expect(recovered.task.status).toBe('assigned');
    expect(recovered.task.assignedAgentId).toBe('codex:peer');
    expect(recovered.ownershipEvent.transition).toBe('force_reassign');
    expect(recovered.ownershipEvent.actorAgentId).toBe('codex:peer');

    const accepted = handleAcceptTask(
      repos,
      {
        task_id: 'TASK-UNOWNED',
        agent_id: 'codex:peer',
        expected_version: recovered.task.version,
      },
      archivedNow,
    );
    expect(accepted.task.status).toBe('active');
    expect(accepted.task.agentId).toBe('codex:peer');

    // Completed/closed unowned tasks cannot be put back into assigned via stale recovery.
    const finished = handleCloseTask(repos, {
      task_id: 'TASK-UNOWNED',
      agent_id: 'codex:peer',
      expected_version: accepted.task.version,
      reason: 'done',
      outcome: 'complete',
    });
    expect(() =>
      handleReassignTask(
        repos,
        {
          task_id: 'TASK-UNOWNED',
          to_agent_id: 'claude-code:stale',
          agent_id: 'claude-code:stale',
          expected_version: finished.task.version,
          reason: 'revive finished task',
          force: true,
        },
        archivedNow + 70 * 60 * 1000,
      ),
    ).toThrow(/reopen it before reassignment\.$/u);
  });

  it('protects live handoff recipients and expires displaced handoffs on forced recovery', () => {
    handleRegisterAgent(repos, { agent_id: 'claude-code:sender', kind: 'claude-code' });
    handleRegisterAgent(repos, { agent_id: 'codex:recipient', kind: 'codex' });
    handleRegisterAgent(repos, { agent_id: 'gemini:third', kind: 'gemini' });
    handleClaimWork(repos, {
      task_id: 'TASK-HANDOFF',
      title: 'Handoff in flight',
      agent_id: 'claude-code:sender',
    });

    const offered = handleOfferHandoff(repos, {
      task_id: 'TASK-HANDOFF',
      agent_id: 'claude-code:sender',
      to_agent_id: 'codex:recipient',
      expected_version: 1,
      what_changed: 'API wired',
    });

    // Sender goes away, but recipient stays live: neither a third party nor the recipient can reassign;
    // the error directs callers to accept instead.
    const senderAway = new Date(Date.now() + 40 * 60 * 1000);
    repos.db
      .prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?')
      .run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), 'claude-code:sender');
    expect(() =>
      handleReassignTask(repos, {
        task_id: 'TASK-HANDOFF',
        to_agent_id: 'gemini:third',
        agent_id: 'gemini:third',
        expected_version: offered.task.version,
        reason: 'take over while recipient is live',
        force: true,
      }),
    ).toThrow(/pending handoff for active agent codex:recipient.*action: 'accept'/u);
    expect(() =>
      handleReassignTask(repos, {
        task_id: 'TASK-HANDOFF',
        to_agent_id: 'codex:recipient',
        agent_id: 'codex:recipient',
        expected_version: offered.task.version,
        reason: 'recipient tries reassign instead of accept',
        force: true,
      }),
    ).toThrow(/codex:recipient must accept it with transfer_work \(action: 'accept'/u);

    // Same guidance when an ownerless task has a live pending assignment after the owner goes away.
    handleClaimWork(repos, {
      task_id: 'TASK-ASSIGNED',
      title: 'Assignment in flight',
      agent_id: 'claude-code:sender',
    });
    const assigned = handleAssignTask(repos, {
      task_id: 'TASK-ASSIGNED',
      to_agent_id: 'codex:recipient',
      agent_id: 'claude-code:sender',
      expected_version: 1,
    });
    repos.db
      .prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?')
      .run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), 'claude-code:sender');
    expect(() =>
      handleReassignTask(repos, {
        task_id: 'TASK-ASSIGNED',
        to_agent_id: 'gemini:third',
        agent_id: 'gemini:third',
        expected_version: assigned.task.version,
        reason: 'take over while assignee is live',
        force: true,
      }),
    ).toThrow(/pending assignment for active agent codex:recipient.*action: 'accept'/u);

    // Once both sender and recipient are away, forced recovery succeeds and expires the old handoff.
    const bothAwayNow = senderAway.getTime() + 40 * 60 * 1000;
    const recovered = handleReassignTask(
      repos,
      {
        task_id: 'TASK-HANDOFF',
        to_agent_id: 'gemini:third',
        agent_id: 'gemini:third',
        expected_version: offered.task.version,
        reason: 'Both sender and recipient inactive',
        force: true,
      },
      bothAwayNow,
    );
    expect(recovered.task.status).toBe('assigned');
    expect(repos.handoffs.pendingForTask('TASK-HANDOFF')).toBeUndefined();
    expect(repos.handoffs.get(offered.handoff.id)?.deliveryStatus).toBe('expired');
    expect(() =>
      handleAcceptHandoff(repos, {
        task_id: 'TASK-HANDOFF',
        handoff_id: offered.handoff.id,
        agent_id: 'codex:recipient',
        expected_version: recovered.task.version,
      }),
    ).toThrow(/Pending handoff/u);
  });

  it('lets an assignee decline without discarding the previous owner', () => {
    const assigned = handleAssignTask(repos, {
      task_id: 'TASK-1',
      to_agent_id: 'codex:target',
      agent_id: 'codex:owner',
      expected_version: 1,
    });
    const declined = handleReleaseTask(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:target',
      expected_version: assigned.task.version,
      reason: 'no capacity',
    });
    expect(declined.task.status).toBe('active');
    expect(declined.task.agentId).toBe('codex:owner');
  });

  it('releases, closes, and reopens owned work with version checks', () => {
    const released = handleReleaseTask(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:owner',
      expected_version: 1,
      reason: 'capacity',
    });
    expect(released.task.status).toBe('proposed');
    expect(released.task.agentId).toBeNull();

    const assigned = handleAssignTask(repos, {
      task_id: 'TASK-1',
      to_agent_id: 'codex:owner',
      agent_id: 'codex:owner',
      expected_version: 2,
    });
    const accepted = handleAcceptTask(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:owner',
      expected_version: assigned.task.version,
    });
    const closed = handleCloseTask(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:owner',
      expected_version: accepted.task.version,
      reason: 'merged',
    });
    const reopened = handleReopenTask(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:owner',
      expected_version: closed.task.version,
      reason: 'regression',
    });

    expect(closed.task.status).toBe('closed');
    expect(reopened.task.status).toBe('active');
    expect(reopened.task.version).toBe(6);

    const completed = handleCloseTask(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:owner',
      expected_version: reopened.task.version,
      reason: 'verified complete',
      outcome: 'complete',
    });
    expect(completed.task.status).toBe('complete');
  });

  it('points callers to start_work or assign when reassigning a released ownerless task', () => {
    handleRegisterAgent(repos, { agent_id: 'claude-code:owner', kind: 'claude-code' });
    handleRegisterAgent(repos, { agent_id: 'codex:peer', kind: 'codex' });
    handleClaimWork(repos, {
      task_id: 'TASK-PROPOSED',
      title: 'Released task',
      agent_id: 'claude-code:owner',
    });

    const released = handleReleaseTask(repos, {
      task_id: 'TASK-PROPOSED',
      agent_id: 'claude-code:owner',
      expected_version: 1,
      reason: 'stepping back',
    });
    expect(released.task.status).toBe('proposed');
    expect(released.task.agentId).toBeNull();

    for (const force of [undefined, true]) {
      const attempt = (): void => {
        handleReassignTask(repos, {
          task_id: 'TASK-PROPOSED',
          to_agent_id: 'codex:peer',
          agent_id: 'codex:peer',
          expected_version: released.task.version,
          reason: 'pick up released work',
          force,
        });
      };
      expect(attempt).toThrow(/proposed.*start_work.*action: 'assign'/u);
      expect(attempt).not.toThrow(/force: true/u);
    }
  });

  it('expires a pending handoff when the owner closes the task', () => {
    const offered = handleOfferHandoff(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:owner',
      to_agent_id: 'codex:target',
      expected_version: 1,
      what_changed: 'draft ready for handoff',
    });
    expect(offered.task.status).toBe('handoff_offered');
    expect(repos.handoffs.pendingForTask('TASK-1')?.id).toBe(offered.handoff.id);

    const closed = handleCloseTask(repos, {
      task_id: 'TASK-1',
      agent_id: 'codex:owner',
      expected_version: offered.task.version,
      reason: 'resolved directly',
    });
    expect(closed.task.status).toBe('closed');
    expect(closed.task.assignedAgentId).toBeNull();
    expect(repos.handoffs.pendingForTask('TASK-1')).toBeUndefined();
    expect(repos.handoffs.get(offered.handoff.id)?.deliveryStatus).toBe('expired');
    expect(repos.handoffs.get(offered.handoff.id)?.resolutionReason).toBe('resolved directly');

    expect(() =>
      handleAcceptHandoff(repos, {
        task_id: 'TASK-1',
        handoff_id: offered.handoff.id,
        agent_id: 'codex:target',
        expected_version: closed.task.version,
      }),
    ).toThrow(/Pending handoff/u);
  });

  it('holds the SQLite write lock across liveness check and ownership change across two connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-lifecycle-lock-'));
    const dbPath = join(dir, 'concord.db');
    const dbA = openDatabase(dbPath);
    const dbB = openDatabase(dbPath);
    try {
      const reposA = createRepositories(dbA);
      const reposB = createRepositories(dbB);
      dbB.pragma('busy_timeout = 0');

      handleRegisterAgent(reposA, { agent_id: 'claude-code:stale', kind: 'claude-code' });
      handleRegisterAgent(reposA, { agent_id: 'codex:peer', kind: 'codex' });
      handleClaimWork(reposA, {
        task_id: 'TASK-RACE',
        title: 'Concurrent ownerless claim',
        agent_id: 'claude-code:stale',
      });
      dbA
        .prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?')
        .run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), 'claude-code:stale');

      let competingWriteError: string | undefined;
      let intercepted = false;
      const interceptedReposA: Repositories = {
        ...reposA,
        agents: {
          ...reposA.agents,
          get(agentId) {
            const agent = reposA.agents.get(agentId);
            if (!intercepted && agentId === 'claude-code:stale') {
              intercepted = true;
              // Simulate the owner attempting to record progress on a second connection
              // right as connection A checks liveness. Because connection A already holds
              // an IMMEDIATE write lock, connection B cannot slip in between check and write.
              try {
                handleUpdateTask(reposB, {
                  task_id: 'TASK-RACE',
                  kind: 'progress',
                  content: 'still working',
                  agent_id: 'claude-code:stale',
                });
              } catch (error) {
                competingWriteError = error instanceof Error ? error.message : String(error);
              }
            }
            return agent;
          },
        },
      };

      const reassigned = handleReassignTask(interceptedReposA, {
        task_id: 'TASK-RACE',
        to_agent_id: 'codex:peer',
        agent_id: 'codex:peer',
        expected_version: 1,
        reason: 'Previous owner inactive',
        force: true,
      });

      expect(intercepted).toBe(true);
      expect(competingWriteError).toMatch(/database is locked/u);
      expect(reassigned.task.status).toBe('assigned');
      expect(reassigned.task.assignedAgentId).toBe('codex:peer');
      expect(reposB.taskUpdates.listByTask('TASK-RACE')).toHaveLength(0);
    } finally {
      dbB.close();
      dbA.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects forced reassignment when the owner records progress on a second connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-lifecycle-race-'));
    const dbPath = join(dir, 'concord.db');
    const dbA = openDatabase(dbPath);
    let workerDone: Promise<void> | undefined;
    try {
      const reposA = createRepositories(dbA);
      handleRegisterAgent(reposA, { agent_id: 'claude-code:stale', kind: 'claude-code' });
      handleRegisterAgent(reposA, { agent_id: 'codex:peer', kind: 'codex' });
      handleClaimWork(reposA, {
        task_id: 'TASK-RACE',
        title: 'In-progress ownerless claim',
        agent_id: 'claude-code:stale',
      });
      dbA
        .prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?')
        .run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), 'claude-code:stale');

      const betterSqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
      const workerScript = `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.betterSqlitePath);
        const db = new Database(workerData.dbPath);
        db.pragma('busy_timeout = 5000');
        db.exec('BEGIN IMMEDIATE');
        parentPort.postMessage('locked');
        setTimeout(() => {
          try {
            const now = new Date().toISOString();
            db.prepare(
              'INSERT INTO task_updates (project, task_id, kind, content, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(workerData.project, workerData.taskId, 'progress', 'still working', workerData.ownerAgentId, now);
            db.prepare('UPDATE tasks SET updated_at = ? WHERE project = ? AND task_id = ?').run(
              now,
              workerData.project,
              workerData.taskId,
            );
            db.prepare('UPDATE agents SET activity_at = ?, last_seen = ? WHERE agent_id = ?').run(
              now,
              now,
              workerData.ownerAgentId,
            );
            db.exec('COMMIT');
          } catch (error) {
            if (db.inTransaction) db.exec('ROLLBACK');
            throw error;
          } finally {
            db.close();
          }
        }, 100);
      `;

      const worker = new Worker(workerScript, {
        eval: true,
        workerData: {
          betterSqlitePath,
          dbPath,
          project: LOCAL_PROJECT,
          taskId: 'TASK-RACE',
          ownerAgentId: 'claude-code:stale',
        },
      });

      workerDone = new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Worker exited with code ${String(code)}`));
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('message', (message) => {
          if (message === 'locked') {
            resolve();
          }
        });
      });

      // Connection B holds BEGIN IMMEDIATE while claude-code:stale is still away in the committed
      // snapshot, then records progress (without bumping task.version) and commits. Because
      // handleReassignTask runs its liveness check inside BEGIN IMMEDIATE, it waits for connection
      // B's commit, sees the live owner, and rejects the takeover.
      let reassignedError: string | undefined;
      try {
        handleReassignTask(reposA, {
          task_id: 'TASK-RACE',
          to_agent_id: 'codex:peer',
          agent_id: 'codex:peer',
          expected_version: 1,
          reason: 'Previous owner inactive',
          force: true,
        });
      } catch (error) {
        reassignedError = error instanceof Error ? error.message : String(error);
      }

      await workerDone;
      expect(reassignedError).toMatch(
        /Only the current owner \(claude-code:stale\) can reassign TASK-RACE while its session is still active\.$/u,
      );
      const task = reposA.tasks.get('TASK-RACE');
      expect(task?.status).toBe('active');
      expect(task?.agentId).toBe('claude-code:stale');
      expect(task?.assignedAgentId).toBeNull();
      expect(task?.version).toBe(1);
      expect(reposA.taskUpdates.listByTask('TASK-RACE')).toHaveLength(1);
    } finally {
      await workerDone?.catch(() => undefined);
      dbA.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
