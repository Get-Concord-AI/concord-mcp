import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import {
  handleAcceptTask,
  handleAssignTask,
  handleCloseTask,
  handleReassignTask,
  handleReleaseTask,
  handleReopenTask,
} from '../../src/tools/task-lifecycle.js';

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
    ).toThrow(/human owner alex/u);

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
});

describe('orphaned ownerless claims', () => {
  const THIRTY_ONE_MINUTES = 31 * 60 * 1000;
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    // A session that claimed work without ever naming a human owner, then died.
    handleRegisterAgent(repos, { agent_id: 'opencode:ghost', kind: 'opencode' });
    handleRegisterAgent(repos, { agent_id: 'claude:rescuer', kind: 'claude-code', owner: 'alex' });
    handleRegisterAgent(repos, { agent_id: 'codex:anonymous', kind: 'codex' });
    handleClaimWork(repos, { task_id: 'TASK-GHOST', title: 'Orphaned', agent_id: 'opencode:ghost' });
  });

  it('lets an owner-registered agent force-take an ownerless task once its claimant is away', () => {
    const rescued = handleReassignTask(
      repos,
      {
        task_id: 'TASK-GHOST',
        to_agent_id: 'claude:rescuer',
        agent_id: 'claude:rescuer',
        expected_version: 1,
        force: true,
        reason: 'claimant session ended',
      },
      Date.now() + THIRTY_ONE_MINUTES,
    );
    expect(rescued.task.status).toBe('assigned');
    expect(rescued.task.assignedAgentId).toBe('claude:rescuer');
    expect(
      repos.ownershipEvents.listByTask('TASK-GHOST').map((event) => event.transition),
    ).toContain('force_reassign');
  });

  it('still refuses while the ownerless claimant is live', () => {
    expect(() =>
      handleReassignTask(repos, {
        task_id: 'TASK-GHOST',
        to_agent_id: 'claude:rescuer',
        agent_id: 'claude:rescuer',
        expected_version: 1,
        force: true,
        reason: 'too eager',
      }),
    ).toThrow(/can (?:force-)?reassign/);
  });

  it('refuses rescue by an agent with no registered human owner', () => {
    expect(() =>
      handleReassignTask(
        repos,
        {
          task_id: 'TASK-GHOST',
          to_agent_id: 'codex:anonymous',
          agent_id: 'codex:anonymous',
          expected_version: 1,
          force: true,
          reason: 'anonymous scoop',
        },
        Date.now() + THIRTY_ONE_MINUTES,
      ),
    ).toThrow(/can (?:force-)?reassign/);
  });

  it('never widens takeover of a task that names a different human owner', () => {
    handleRegisterAgent(repos, { agent_id: 'opencode:sams', kind: 'opencode', owner: 'sam' });
    handleClaimWork(repos, {
      task_id: 'TASK-SAM',
      title: 'Owned by sam',
      owner: 'sam',
      agent_id: 'opencode:sams',
    });
    expect(() =>
      handleReassignTask(
        repos,
        {
          task_id: 'TASK-SAM',
          to_agent_id: 'claude:rescuer',
          agent_id: 'claude:rescuer',
          expected_version: 1,
          force: true,
          reason: 'not my task',
        },
        Date.now() + THIRTY_ONE_MINUTES,
      ),
    ).toThrow(/can (?:force-)?reassign/);
  });

  it('lets an owner-registered agent reopen an ownerless terminal task once its claimant is away', () => {
    const closed = handleCloseTask(repos, {
      task_id: 'TASK-GHOST',
      agent_id: 'opencode:ghost',
      expected_version: 1,
      reason: 'done',
      outcome: 'complete',
    });
    const reopened = handleReopenTask(
      repos,
      {
        task_id: 'TASK-GHOST',
        agent_id: 'claude:rescuer',
        expected_version: closed.task.version,
        reason: 'closure record incomplete',
      },
      Date.now() + THIRTY_ONE_MINUTES,
    );
    expect(reopened.task.status).toBe('active');
    expect(reopened.task.agentId).toBe('claude:rescuer');
  });

  it('still refuses reopen of an ownerless terminal task while its claimant is live', () => {
    const closed = handleCloseTask(repos, {
      task_id: 'TASK-GHOST',
      agent_id: 'opencode:ghost',
      expected_version: 1,
      reason: 'done',
      outcome: 'complete',
    });
    expect(() =>
      handleReopenTask(repos, {
        task_id: 'TASK-GHOST',
        agent_id: 'claude:rescuer',
        expected_version: closed.task.version,
        reason: 'too eager',
      }),
    ).toThrow(/cannot reopen/);
  });
});
