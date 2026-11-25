import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildStatus } from '../../src/artifacts/work-state-view.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import { handleAssignTask, handleReassignTask } from '../../src/tools/task-lifecycle.js';

const START = Date.parse('2026-11-08T10:00:00Z');

describe('assignment acceptance clock', () => {
  let repos: Repositories;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    repos = createRepositories(openDatabase(':memory:'));
    for (const id of ['owner', 'first', 'second']) {
      handleRegisterAgent(repos, { agent_id: id, kind: 'codex' });
    }
    handleClaimWork(repos, { task_id: 'T-1', title: 'Assigned work', agent_id: 'owner' });
    vi.setSystemTime(START + 60 * 60_000);
    handleAssignTask(repos, {
      task_id: 'T-1',
      agent_id: 'owner',
      to_agent_id: 'first',
      expected_version: 1,
    });
    repos.agents.heartbeat('first');
  });
  afterEach(() => {
    repos.db.close();
    vi.useRealTimers();
  });

  it('starts at assignment rather than task creation', () => {
    expect(buildStatus(repos).staleClaims).toEqual([]);
  });

  it('keeps an overdue assignment visible after a task-scoped reminder', () => {
    vi.setSystemTime(START + 91 * 60_000);
    repos.agents.heartbeat('first');
    expect(buildStatus(repos).staleClaims[0]?.ageSeconds).toBe(31 * 60);
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'owner',
      toAgentId: 'first',
      taskId: 'T-1',
      content: 'Please accept the assignment',
      idempotencyKey: 'reminder',
    });
    expect(buildStatus(repos).staleClaims).toMatchObject([
      { taskId: 'T-1', reason: 'assignment-unaccepted', ageSeconds: 31 * 60 },
    ]);
  });

  it('starts a fresh clock on reassignment instead of using the earlier assignment', () => {
    vi.setSystemTime(START + 91 * 60_000);
    repos.agents.heartbeat('second');
    handleReassignTask(repos, {
      task_id: 'T-1',
      agent_id: 'owner',
      to_agent_id: 'second',
      expected_version: 2,
      reason: 'Route to the second agent',
    });
    expect(buildStatus(repos).staleClaims).toEqual([]);
  });
});
