import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleHandoff } from '../../src/tools/handoff.js';
import { ensureAgentRegistered, handleRegisterAgent } from '../../src/tools/register-agent.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';

describe('handleRegisterAgent', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('registers a new agent under the identity it was given', () => {
    const result = handleRegisterAgent(repos, {
      agent_id: 'claude-code:abcd1234',
      kind: 'claude-code',
      owner: 'alex',
    });
    expect(result.firstRegistration).toBe(true);
    expect(result.agent.agentId).toBe('claude-code:abcd1234');
    expect(result.agent.status).toBe('active');
    expect(result.roster).toHaveLength(1);
    expect(result.roster[0]?.liveness).toBe('live');
  });

  it('reuses a supplied agent_id and refreshes on re-register without duplicating', () => {
    const first = handleRegisterAgent(repos, {
      agent_id: 'claude-code:7p8v',
      kind: 'claude-code',
      summary: 'building frontend',
    });
    expect(first.firstRegistration).toBe(true);

    const again = handleRegisterAgent(repos, {
      agent_id: 'claude-code:7p8v',
      kind: 'claude-code',
      summary: 'now reviewing',
      status: 'waiting_review',
    });
    expect(again.firstRegistration).toBe(false);
    expect(again.agent.summary).toBe('now reviewing');
    expect(again.agent.status).toBe('waiting_review');
    expect(repos.agents.list()).toHaveLength(1);
  });

  it('returns a roster of every registered agent', () => {
    handleRegisterAgent(repos, {
      agent_id: 'codex:9q2r',
      kind: 'codex',
      summary: 'building the backend',
    });
    const result = handleRegisterAgent(repos, {
      agent_id: 'claude-code:7p8v',
      kind: 'claude-code',
    });
    expect(result.roster.map((entry) => entry.agentId).sort()).toEqual([
      'claude-code:7p8v',
      'codex:9q2r',
    ]);
    expect(result.roster.find((entry) => entry.agentId === 'codex:9q2r')?.summary).toBe(
      'building the backend',
    );
  });
});

describe('ensureAgentRegistered', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('creates a presence row for a session that knows only who it is', () => {
    const agent = ensureAgentRegistered(
      repos,
      { agentId: 'claude-code:abcd1234', kind: 'claude-code' },
      '/repo',
    );

    expect(agent.agentId).toBe('claude-code:abcd1234');
    expect(agent.cwd).toBe('/repo');
  });

  it('never blanks metadata a richer registration already recorded', () => {
    // The relay calls this every couple of seconds; it must not erase start_work's metadata.
    handleRegisterAgent(repos, {
      agent_id: 'claude-code:abcd1234',
      kind: 'claude-code',
      owner: 'alex',
      summary: 'building the relay',
    });

    ensureAgentRegistered(repos, { agentId: 'claude-code:abcd1234', kind: 'claude-code' }, '/repo');

    expect(repos.agents.get('claude-code:abcd1234')?.summary).toBe('building the relay');
    expect(repos.agents.get('claude-code:abcd1234')?.owner).toBe('alex');
    expect(repos.agents.list()).toHaveLength(1);
  });
});

describe('presence refresh through write tools', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    handleRegisterAgent(repos, { agent_id: 'claude-code:7p8v', kind: 'claude-code' });
  });

  it('claim_work with a registered agent_id keeps the agent present, adds no rows', () => {
    handleClaimWork(repos, {
      task_id: 'TASK-1',
      title: 'Work',
      modules: ['billing'],
      agent_id: 'claude-code:7p8v',
    });
    expect(repos.agents.get('claude-code:7p8v')).toBeDefined();
    expect(repos.agents.list()).toHaveLength(1);
  });

  it('rejects a write with an unregistered agent_id and creates no ghost row', () => {
    expect(() =>
      handleClaimWork(repos, { task_id: 'TASK-2', title: 'Work', agent_id: 'ghost:zzzz' }),
    ).toThrow(/not registered/u);
    expect(repos.agents.get('ghost:zzzz')).toBeUndefined();
    expect(repos.agents.list()).toHaveLength(1);
  });

  it('update_task and handoff also accept and refresh a registered agent_id', () => {
    handleClaimWork(repos, { task_id: 'TASK-3', title: 'Work', agent_id: 'claude-code:7p8v' });
    handleUpdateTask(repos, {
      task_id: 'TASK-3',
      kind: 'progress',
      content: 'halfway',
      agent_id: 'claude-code:7p8v',
    });
    handleHandoff(repos, {
      task_id: 'TASK-3',
      status: 'done',
      what_changed: 'finished',
      agent_id: 'claude-code:7p8v',
      expected_version: 1,
    });
    expect(repos.agents.get('claude-code:7p8v')).toBeDefined();
    expect(repos.agents.list()).toHaveLength(1);
  });

  it('allows collaborative findings but protects owner-only task updates', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:other', kind: 'codex' });
    handleClaimWork(repos, {
      task_id: 'TASK-4',
      title: 'Owned work',
      agent_id: 'claude-code:7p8v',
    });

    expect(() =>
      handleUpdateTask(repos, {
        task_id: 'TASK-4',
        kind: 'progress',
        content: 'pretend progress',
        agent_id: 'codex:other',
      }),
    ).toThrow(/current owner/u);
    expect(() =>
      handleUpdateTask(repos, {
        task_id: 'TASK-4',
        kind: 'finding',
        content: 'related API behavior',
        agent_id: 'codex:other',
      }),
    ).not.toThrow();
  });
});
