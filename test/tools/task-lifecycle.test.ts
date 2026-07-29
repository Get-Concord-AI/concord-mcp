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
