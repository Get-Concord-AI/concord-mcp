import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleGetTaskContext } from '../../src/tools/get-task-context.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';

describe('stale task owner recovery', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    handleRegisterAgent(repos, { agent_id: 'agent:owner', kind: 'codex', owner: 'alex' });
    handleRegisterAgent(repos, { agent_id: 'agent:other', kind: 'codex', owner: 'alex' });
    handleClaimWork(repos, { task_id: 'TASK-1', title: 'Owned task', agent_id: 'agent:owner' });
  });

  function nonOwnerProgress(): void {
    handleUpdateTask(repos, {
      task_id: 'TASK-1',
      kind: 'progress',
      content: 'taking over',
      agent_id: 'agent:other',
    });
  }

  it('reports live ownership and does not suggest a forced takeover', () => {
    expect(handleGetTaskContext(repos, { task_id: 'TASK-1' }).ownerLiveness).toBe('live');
    expect(nonOwnerProgress).toThrow(/current owner is agent:owner\./u);
    expect(nonOwnerProgress).not.toThrow(/force: true/u);
  });

  it('reports away ownership and provides the complete reassign arguments', () => {
    repos.db
      .prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?')
      .run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), 'agent:owner');
    expect(handleGetTaskContext(repos, { task_id: 'TASK-1' }).ownerLiveness).toBe('away');
    expect(nonOwnerProgress).toThrow(/action: 'reassign'.*expected_version: 1.*force: true/u);
  });

  it('reports archived ownership without granting a non-owner write', () => {
    repos.db
      .prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?')
      .run(new Date(Date.now() - 70 * 60 * 1000).toISOString(), 'agent:owner');
    expect(handleGetTaskContext(repos, { task_id: 'TASK-1' }).ownerLiveness).toBe('archived');
    expect(nonOwnerProgress).toThrow(/force: true/u);
    expect(repos.taskUpdates.listByTask('TASK-1')).toHaveLength(0);
  });
});
