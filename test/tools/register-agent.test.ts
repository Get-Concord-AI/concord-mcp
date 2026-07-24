import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleHandoff } from '../../src/tools/handoff.js';
import {
  formatRegisterAgentText,
  generateAgentId,
  handleRegisterAgent,
} from '../../src/tools/register-agent.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';

describe('handleRegisterAgent', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('generates a kind-prefixed id and registers a new agent', () => {
    const result = handleRegisterAgent(repos, { kind: 'claude-code', owner: 'alex' });
    expect(result.firstRegistration).toBe(true);
    expect(result.agent.agentId).toMatch(/^claude-code:[0-9a-f]{4}$/);
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

  it('returns a roster of every registered agent and names others in the text', () => {
    handleRegisterAgent(repos, {
      agent_id: 'codex:9q2r',
      kind: 'codex',
      summary: 'building the backend',
    });
    const result = handleRegisterAgent(repos, { agent_id: 'claude-code:7p8v', kind: 'claude-code' });
    expect(result.roster.map((entry) => entry.agentId).sort()).toEqual([
      'claude-code:7p8v',
      'codex:9q2r',
    ]);
    const text = formatRegisterAgentText(result);
    expect(text).toContain('Registered as claude-code:7p8v');
    expect(text).toContain('1 other agent(s) here');
    expect(text).toContain('codex:9q2r');
    expect(text).toContain('building the backend');
  });

  it('says so when no other agents are registered', () => {
    const result = handleRegisterAgent(repos, { agent_id: 'solo:0001', kind: 'claude-code' });
    expect(formatRegisterAgentText(result)).toContain('No other agents are registered yet.');
  });

  it('generateAgentId produces distinct kind-prefixed ids', () => {
    const a = generateAgentId('codex');
    const b = generateAgentId('codex');
    expect(a).toMatch(/^codex:[0-9a-f]{4}$/);
    expect(a).not.toBe(b);
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

  it('a write with an unregistered agent_id is a safe no-op (no throw, no ghost row)', () => {
    expect(() =>
      handleClaimWork(repos, { task_id: 'TASK-2', title: 'Work', agent_id: 'ghost:zzzz' }),
    ).not.toThrow();
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
    });
    expect(repos.agents.get('claude-code:7p8v')).toBeDefined();
    expect(repos.agents.list()).toHaveLength(1);
  });
});
