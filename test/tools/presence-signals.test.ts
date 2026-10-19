import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildStatus, renderRosterLines } from '../../src/artifacts/work-state-view.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { buildRoster } from '../../src/domain/presence.js';
import { createServer } from '../../src/server.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleHandoff } from '../../src/tools/handoff.js';
import { ensureAgentRegistered, handleRegisterAgent } from '../../src/tools/register-agent.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';
import { renderWorkStateJson } from '../../src/artifacts/work-state-json.js';

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

function metadata(repos: Repositories): unknown[] {
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

describe('heartbeat, activity and reported status stay independent (issue #68)', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    handleRegisterAgent(repos, { ...FULL, summary: 'finished earlier task', status: 'done' });
  });

  it('tool writes by a done agent do not turn it into an executing one', () => {
    handleClaimWork(repos, { task_id: 'T-2', title: 'new work', agent_id: AGENT });
    handleUpdateTask(repos, { task_id: 'T-2', kind: 'progress', content: 'x', agent_id: AGENT });
    handleHandoff(repos, {
      task_id: 'T-2',
      status: 'done',
      what_changed: 'x',
      agent_id: AGENT,
      expected_version: 1,
    });

    const agent = repos.agents.get(AGENT);
    expect(agent?.status).toBe('done');
    expect(agent?.executionStatus).toBe('not_executing');
    expect(agent?.summary).toBe('finished earlier task');
    expect(agent?.activityAt).not.toBeNull();

    const [entry] = buildRoster(repos.agents.list(), Date.now());
    expect(entry?.status).toBe('done');
    expect(entry?.executionStatus).toBe('not_executing');
    expect(entry?.activityAgeSeconds).toBe(0);
  });

  it('an explicit status transition is what makes it executing again', () => {
    handleClaimWork(repos, { task_id: 'T-2', title: 'new work', agent_id: AGENT });
    expect(repos.agents.get(AGENT)?.executionStatus).toBe('not_executing');

    handleRegisterAgent(repos, { agent_id: AGENT, kind: 'claude-code', status: 'active' });

    const agent = repos.agents.get(AGENT);
    expect([agent?.status, agent?.executionStatus]).toEqual(['active', 'executing']);
  });

  it('shows heartbeat, activity and summary age on separate roster fields', () => {
    const t0 = Date.parse('2026-07-24T10:00:00.000Z');
    const iso = (offsetMs: number): string => new Date(t0 + offsetMs).toISOString();
    repos.agents.upsert({ agentId: AGENT, kind: 'claude-code' }, iso(0));
    repos.agents.recordActivity(AGENT, iso(40 * 60_000));
    const now = t0 + 41 * 60_000;

    const [entry] = buildRoster(repos.agents.list(), now);
    expect(entry?.liveness).toBe('live');
    expect(entry?.heartbeatLiveness).toBe('away');
    expect(entry?.heartbeatAgeSeconds).toBe(41 * 60);
    expect(entry?.activityAgeSeconds).toBe(60);
    expect(entry?.status).toBe('done');

    const line = renderRosterLines(entry === undefined ? [] : [entry]).join('\n');
    expect(line).toContain('live/done');
    expect(line).toContain('heartbeat 41m ago');
    expect(line).toContain('activity 1m ago');

    const json: unknown = JSON.parse(
      renderWorkStateJson([], entry === undefined ? [] : [entry], iso(41 * 60_000)),
    );
    expect(json).toMatchObject({
      presence: [
        {
          status: 'done',
          reported_status: 'done',
          execution_status: 'not_executing',
          heartbeat_age_seconds: 41 * 60,
          activity_age_seconds: 60,
        },
      ],
    });
  });
});

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
