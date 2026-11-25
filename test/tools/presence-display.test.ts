import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { renderRosterLines } from '../../src/artifacts/work-state-view.js';
import { renderWorkStateJson } from '../../src/artifacts/work-state-json.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { buildRoster } from '../../src/domain/presence.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleHandoff } from '../../src/tools/handoff.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';

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

    const json = z
      .json()
      .parse(
        JSON.parse(renderWorkStateJson([], entry === undefined ? [] : [entry], iso(41 * 60_000))),
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
