import { describe, expect, it } from 'vitest';

import type { AgentRecord, TaskRecord } from '../../src/db/index.js';
import {
  buildRoster,
  DEFAULT_PRESENCE_THRESHOLDS,
  detectStaleClaims,
  deriveLiveness,
} from '../../src/domain/presence.js';

const NOW = Date.parse('2026-07-24T12:00:00.000Z');

/** An ISO timestamp `ms` before NOW. */
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function agent(partial: Partial<AgentRecord> & { agentId: string }): AgentRecord {
  return {
    agentId: partial.agentId,
    kind: partial.kind ?? 'claude-code',
    owner: partial.owner ?? null,
    model: partial.model ?? null,
    pid: partial.pid ?? null,
    cwd: partial.cwd ?? null,
    worktree: partial.worktree ?? null,
    branch: partial.branch ?? null,
    summary: partial.summary ?? null,
    status: partial.status ?? 'active',
    executionStatus:
      partial.executionStatus ??
      ((partial.status ?? 'active') === 'active' ? 'executing' : 'not_executing'),
    firstSeen: partial.firstSeen ?? ago(60 * 60 * 1000),
    lastSeen: partial.lastSeen ?? ago(0),
    heartbeatAt: partial.heartbeatAt ?? partial.lastSeen ?? ago(0),
    activityAt: partial.activityAt ?? null,
    summaryUpdatedAt: partial.summaryUpdatedAt ?? null,
  };
}

describe('deriveLiveness', () => {
  it('is live under the idle threshold', () => {
    expect(deriveLiveness(ago(60 * 1000), NOW)).toBe('live');
  });

  it('is idle between the idle and away thresholds', () => {
    expect(deriveLiveness(ago(10 * 60 * 1000), NOW)).toBe('idle');
  });

  it('is away between the away and archive thresholds', () => {
    expect(deriveLiveness(ago(45 * 60 * 1000), NOW)).toBe('away');
  });

  it('is archived beyond the archive threshold', () => {
    expect(deriveLiveness(ago(2 * 60 * 60 * 1000), NOW)).toBe('archived');
  });

  it('treats the boundary as the later state (>=)', () => {
    expect(deriveLiveness(ago(5 * 60 * 1000), NOW)).toBe('idle');
    expect(deriveLiveness(ago(30 * 60 * 1000), NOW)).toBe('away');
    expect(deriveLiveness(ago(60 * 60 * 1000), NOW)).toBe('archived');
  });

  it('treats an unparseable timestamp as archived', () => {
    expect(deriveLiveness('not-a-date', NOW)).toBe('archived');
  });

  it('honours custom thresholds', () => {
    expect(
      deriveLiveness(ago(2000), NOW, {
        idleAfterMs: 1000,
        awayAfterMs: 5000,
        archiveAfterMs: 9000,
      }),
    ).toBe('idle');
  });
});

describe('buildRoster', () => {
  it('maps fields and computes whole-second age', () => {
    const [entry] = buildRoster(
      [agent({ agentId: 'claude-code:7p8v', summary: 'building frontend', lastSeen: ago(90_000) })],
      NOW,
    );
    expect(entry?.agentId).toBe('claude-code:7p8v');
    expect(entry?.summary).toBe('building frontend');
    expect(entry?.liveness).toBe('live');
    expect(entry?.ageSeconds).toBe(90);
  });

  it('keeps heartbeat, activity, summary age and reported status separate', () => {
    const [entry] = buildRoster(
      [
        agent({
          agentId: 'claude-code:7p8v',
          summary: 'finished earlier task',
          status: 'done',
          heartbeatAt: ago(40 * 60 * 1000),
          activityAt: ago(10_000),
          lastSeen: ago(10_000),
          summaryUpdatedAt: ago(3 * 60 * 60 * 1000),
        }),
      ],
      NOW,
    );
    expect(entry?.status).toBe('done');
    expect(entry?.executionStatus).toBe('not_executing');
    expect(entry?.liveness).toBe('live');
    expect(entry?.heartbeatLiveness).toBe('away');
    expect(entry?.heartbeatAgeSeconds).toBe(2400);
    expect(entry?.activityAgeSeconds).toBe(10);
    expect(entry?.summaryAgeSeconds).toBe(10_800);
  });

  it('reports no activity or summary age when none was recorded', () => {
    const [entry] = buildRoster([agent({ agentId: 'claude-code:7p8v' })], NOW);
    expect(entry?.activityAt).toBeNull();
    expect(entry?.activityAgeSeconds).toBeNull();
    expect(entry?.summaryAgeSeconds).toBeNull();
  });

  it('orders live agents first, then most-recently-seen', () => {
    const roster = buildRoster(
      [
        agent({ agentId: 'away-old', lastSeen: ago(45 * 60 * 1000) }),
        agent({ agentId: 'live-older', lastSeen: ago(2 * 60 * 1000) }),
        agent({ agentId: 'idle-mid', lastSeen: ago(10 * 60 * 1000) }),
        agent({ agentId: 'live-newer', lastSeen: ago(30 * 1000) }),
      ],
      NOW,
    );
    expect(roster.map((entry) => entry.agentId)).toEqual([
      'live-newer',
      'live-older',
      'idle-mid',
      'away-old',
    ]);
  });

  it('omits archived agents (unseen for an hour) without deleting them', () => {
    const agents = [
      agent({ agentId: 'still-away', lastSeen: ago(45 * 60 * 1000) }),
      agent({ agentId: 'long-gone', lastSeen: ago(3 * 60 * 60 * 1000) }),
    ];
    expect(buildRoster(agents, NOW).map((entry) => entry.agentId)).toEqual(['still-away']);
    expect(agents).toHaveLength(2);
  });

  it('returns an empty roster when no agents are registered', () => {
    expect(buildRoster([], NOW)).toEqual([]);
  });
});

function task(partial: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    taskId: partial.taskId,
    title: partial.title ?? partial.taskId,
    owner: null,
    agent: null,
    branch: null,
    worktree: null,
    expectedFiles: [],
    modules: [],
    domains: [],
    riskTags: [],
    notes: null,
    status: partial.status ?? 'active',
    parentTaskId: null,
    agentId: partial.agentId ?? null,
    version: partial.version ?? 1,
    assignedAgentId: partial.assignedAgentId ?? null,
    leaseExpiresAt: partial.leaseExpiresAt ?? null,
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-07-24T00:00:00.000Z',
  };
}

describe('detectStaleClaims', () => {
  it('flags an active claim whose owning agent is away', () => {
    const stale = detectStaleClaims(
      [task({ taskId: 'T-1', agentId: 'claude-code:7p8v' })],
      [agent({ agentId: 'claude-code:7p8v', lastSeen: ago(45 * 60 * 1000) })],
      NOW,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]?.reason).toBe('agent-away');
    expect(stale[0]?.taskId).toBe('T-1');
    expect(stale[0]?.ageSeconds).toBe(2700);
  });

  it('still flags a claim whose owning agent is archived', () => {
    const stale = detectStaleClaims(
      [task({ taskId: 'T-1', agentId: 'claude-code:7p8v' })],
      [agent({ agentId: 'claude-code:7p8v', lastSeen: ago(2 * 60 * 60 * 1000) })],
      NOW,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]?.reason).toBe('agent-away');
    expect(stale[0]?.ageSeconds).toBe(7200);
  });

  it('flags a claim whose agent never registered', () => {
    const stale = detectStaleClaims([task({ taskId: 'T-1', agentId: 'ghost:zzzz' })], [], NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.reason).toBe('agent-unregistered');
    expect(stale[0]?.ageSeconds).toBeNull();
  });

  it('does not flag a claim whose agent is still live', () => {
    const stale = detectStaleClaims(
      [task({ taskId: 'T-1', agentId: 'claude-code:7p8v' })],
      [agent({ agentId: 'claude-code:7p8v', lastSeen: ago(60 * 1000) })],
      NOW,
    );
    expect(stale).toEqual([]);
  });

  it('ignores tasks that are no longer in progress', () => {
    const stale = detectStaleClaims(
      [
        task({ taskId: 'T-1', agentId: 'ghost:zzzz', status: 'handed_off' }),
        task({ taskId: 'T-2', agentId: 'ghost:zzzz', status: 'complete' }),
        task({ taskId: 'T-3', agentId: 'ghost:zzzz', status: 'review_ready' }),
      ],
      [],
      NOW,
    );
    expect(stale).toEqual([]);
  });

  it('flags an in-progress claim with no owning agent instead of skipping it', () => {
    const stale = detectStaleClaims(
      [
        task({ taskId: 'T-1', agentId: null }),
        task({ taskId: 'T-2', agentId: null, status: 'blocked' }),
      ],
      [],
      NOW,
    );
    expect(stale.map((claim) => [claim.taskId, claim.reason, claim.agentId])).toEqual([
      ['T-1', 'unowned', null],
      ['T-2', 'unowned', null],
    ]);
  });

  it('does not treat the agent kind string as a holder', () => {
    const anonymous = { ...task({ taskId: 'T-1', agentId: null }), agent: 'claude-code' };
    const live = agent({ agentId: 'claude-code:7p8v', kind: 'claude-code' });
    const stale = detectStaleClaims([anonymous], [live], NOW);
    expect(stale.map((claim) => claim.reason)).toEqual(['unowned']);
  });

  it('flags a crashed session: executing, but heartbeat and activity both stopped', () => {
    const crashed = agent({
      agentId: 'claude-code:7p8v',
      status: 'active',
      executionStatus: 'executing',
      heartbeatAt: ago(50 * 60 * 1000),
      activityAt: ago(40 * 60 * 1000),
      lastSeen: ago(40 * 60 * 1000),
    });
    const stale = detectStaleClaims(
      [task({ taskId: 'T-1', agentId: 'claude-code:7p8v' })],
      [crashed],
      NOW,
    );
    expect(stale.map((claim) => [claim.reason, claim.ageSeconds])).toEqual([['agent-away', 2400]]);
  });

  it('keeps an owner present while it is still writing, even without a heartbeat', () => {
    const writing = agent({
      agentId: 'codex:one',
      heartbeatAt: ago(50 * 60 * 1000),
      activityAt: ago(60 * 1000),
      lastSeen: ago(60 * 1000),
    });
    const stale = detectStaleClaims(
      [task({ taskId: 'T-1', agentId: 'codex:one' })],
      [writing],
      NOW,
    );
    expect(stale).toEqual([]);
  });
});

describe('detectStaleClaims for assigned tasks', () => {
  const assignee = agent({ agentId: 'codex:two', lastSeen: ago(60 * 1000) });
  const assigned = (partial: Partial<TaskRecord> = {}): TaskRecord =>
    task({
      taskId: 'T-9',
      status: 'assigned',
      assignedAgentId: 'codex:two',
      updatedAt: ago(60 * 1000),
      ...partial,
    });

  it('does not flag a fresh assignment to a present assignee', () => {
    expect(detectStaleClaims([assigned()], [assignee], NOW)).toEqual([]);
  });

  it('flags an assignment nobody accepted within the threshold', () => {
    const stale = detectStaleClaims(
      [assigned({ updatedAt: ago(31 * 60 * 1000) })],
      [assignee],
      NOW,
    );
    expect(stale.map((claim) => [claim.reason, claim.agentId, claim.ageSeconds])).toEqual([
      ['assignment-unaccepted', 'codex:two', 1860],
    ]);
  });

  it('treats the acceptance threshold boundary as the later state (>=)', () => {
    const justUnder = assigned({ updatedAt: ago(30 * 60 * 1000 - 1) });
    const exactly = assigned({ updatedAt: ago(30 * 60 * 1000) });
    expect(detectStaleClaims([justUnder], [assignee], NOW)).toEqual([]);
    expect(detectStaleClaims([exactly], [assignee], NOW)).toHaveLength(1);
  });

  it('honours a custom acceptance threshold', () => {
    const thresholds = { ...DEFAULT_PRESENCE_THRESHOLDS, assignmentAcceptAfterMs: 1000 };
    const stale = detectStaleClaims(
      [assigned({ updatedAt: ago(2000) })],
      [assignee],
      NOW,
      thresholds,
    );
    expect(stale).toHaveLength(1);
  });

  it('flags an assignment whose assignee has gone away, even if recent', () => {
    const away = agent({ agentId: 'codex:two', lastSeen: ago(45 * 60 * 1000) });
    const stale = detectStaleClaims([assigned()], [away], NOW);
    expect(stale.map((claim) => claim.reason)).toEqual(['assignment-unaccepted']);
  });

  it('flags an assignment whose lease has expired', () => {
    const stale = detectStaleClaims([assigned({ leaseExpiresAt: ago(1000) })], [assignee], NOW);
    expect(stale.map((claim) => claim.reason)).toEqual(['assignment-unaccepted']);
  });

  it('flags an assignee that never registered', () => {
    const stale = detectStaleClaims([assigned()], [], NOW);
    expect(stale.map((claim) => [claim.reason, claim.agentId])).toEqual([
      ['agent-unregistered', 'codex:two'],
    ]);
  });

  it('flags an assigned task that names no assignee', () => {
    const stale = detectStaleClaims([assigned({ assignedAgentId: null })], [assignee], NOW);
    expect(stale.map((claim) => [claim.reason, claim.agentId])).toEqual([['unowned', null]]);
  });
});
