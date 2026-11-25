import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import { ensureAgentRegistered, handleRegisterAgent } from '../../src/tools/register-agent.js';

const AGENT = 'claude-code:7p8v';
const FULL = {
  agent_id: AGENT,
  kind: 'claude-code',
  owner: 'alex',
  model: 'opus',
  pid: 4242,
  cwd: '/work/avios-cli',
  worktree: '/work/avios-cli-wt',
  branch: 'feat/x',
} as const;

function metadata(repos: Repositories) {
  const agent = repos.agents.get(AGENT);
  return [agent?.owner, agent?.model, agent?.pid, agent?.cwd, agent?.worktree, agent?.branch];
}

describe('register_agent patch semantics (issue #68)', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('a summary-only refresh preserves cwd, worktree, owner, model and pid', () => {
    handleRegisterAgent(repos, { ...FULL, summary: 'first task' });
    handleRegisterAgent(repos, { agent_id: AGENT, kind: 'claude-code', summary: 'taking over' });

    expect(metadata(repos)).toEqual([
      'alex',
      'opus',
      4242,
      '/work/avios-cli',
      '/work/avios-cli-wt',
      'feat/x',
    ]);
    expect(repos.agents.get(AGENT)?.summary).toBe('taking over');
  });

  it('a status-only refresh preserves the same metadata and the summary', () => {
    handleRegisterAgent(repos, { ...FULL, summary: 'first task' });
    handleRegisterAgent(repos, { agent_id: AGENT, kind: 'claude-code', status: 'blocked' });

    expect(metadata(repos)).toEqual([
      'alex',
      'opus',
      4242,
      '/work/avios-cli',
      '/work/avios-cli-wt',
      'feat/x',
    ]);
    expect(repos.agents.get(AGENT)?.summary).toBe('first task');
    expect(repos.agents.get(AGENT)?.status).toBe('blocked');
  });

  it('an explicit null clears just that field', () => {
    handleRegisterAgent(repos, { ...FULL, summary: 'first task' });
    handleRegisterAgent(repos, { agent_id: AGENT, kind: 'claude-code', worktree: null, pid: null });

    expect(metadata(repos)).toEqual(['alex', 'opus', null, '/work/avios-cli', null, 'feat/x']);
  });

  it('start_work without optional metadata does not erase what an earlier call recorded', async () => {
    const server = createServer(repos);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'presence-test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      await client.callTool({
        name: 'start_work',
        arguments: { ...FULL, task_id: 'T-1', title: 'First task' },
      });
      const second = await client.callTool({
        name: 'start_work',
        arguments: { task_id: 'T-2', title: 'Second task', kind: 'claude-code', agent_id: AGENT },
      });

      expect(second.isError).not.toBe(true);
      expect(metadata(repos)).toEqual([
        'alex',
        'opus',
        4242,
        '/work/avios-cli',
        '/work/avios-cli-wt',
        'feat/x',
      ]);
      expect(repos.agents.get(AGENT)?.summary).toBe('Second task');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('ensureAgentRegistered heartbeats an existing agent and fills only a missing cwd', () => {
    handleRegisterAgent(repos, { agent_id: AGENT, kind: 'claude-code', owner: 'alex' });
    const before = repos.agents.get(AGENT);

    ensureAgentRegistered(repos, { agentId: AGENT, kind: 'claude-code' }, '/first/cwd');
    expect(repos.agents.get(AGENT)?.cwd).toBe('/first/cwd');
    ensureAgentRegistered(repos, { agentId: AGENT, kind: 'claude-code' }, '/other/cwd');

    const after = repos.agents.get(AGENT);
    expect(after?.cwd).toBe('/first/cwd');
    expect(after?.owner).toBe('alex');
    expect(after?.status).toBe('active');
    expect(after?.firstSeen).toBe(before?.firstSeen);
    expect(Date.parse(after?.heartbeatAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(before?.heartbeatAt ?? ''),
    );
  });
});
