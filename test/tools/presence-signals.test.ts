import { beforeEach, describe, expect, it } from 'vitest';
import { buildStatus } from '../../src/artifacts/work-state-view.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

const AGENT = 'claude-code:7p8v';

describe('stale work is surfaced in the status view (issue #68)', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('reports an in-progress claim with no agent_id as unowned', () => {
    handleClaimWork(repos, { task_id: 'T-1', title: 'anonymous', modules: ['x'] });

    const view = buildStatus(repos, Date.now());
    expect(view.staleClaims.map((claim) => [claim.taskId, claim.reason, claim.agentId])).toEqual([
      ['T-1', 'unowned', null],
    ]);
  });

  it('reports an assignment nobody accepted, and one to an unregistered assignee', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:two', kind: 'codex' });
    const base = {
      title: 'assigned',
      owner: null,
      agent: null,
      branch: null,
      worktree: null,
      expectedFiles: [],
      modules: [],
      domains: [],
      riskTags: [],
      notes: null,
      parentTaskId: null,
      agentId: null,
      status: 'assigned',
    } as const;
    repos.tasks.create({ ...base, taskId: 'T-waiting', assignedAgentId: 'codex:two' });
    repos.tasks.create({ ...base, taskId: 'T-ghost', assignedAgentId: 'ghost:zzzz' });

    const fresh = buildStatus(repos, Date.now());
    expect(fresh.staleClaims.map((claim) => [claim.taskId, claim.reason])).toEqual([
      ['T-ghost', 'agent-unregistered'],
    ]);

    const later = buildStatus(repos, Date.now() + 31 * 60_000);
    expect(later.staleClaims.map((claim) => [claim.taskId, claim.reason]).sort()).toEqual([
      ['T-ghost', 'agent-unregistered'],
      ['T-waiting', 'assignment-unaccepted'],
    ]);
  });

  it('reports an accepted task whose owner went away', () => {
    handleRegisterAgent(repos, { agent_id: AGENT, kind: 'claude-code' });
    handleClaimWork(repos, { task_id: 'T-1', title: 'owned', agent_id: AGENT });

    expect(buildStatus(repos, Date.now()).staleClaims).toEqual([]);
    const away = buildStatus(repos, Date.now() + 45 * 60_000);
    expect(away.staleClaims.map((claim) => claim.reason)).toEqual(['agent-away']);
  });
});
