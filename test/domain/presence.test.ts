import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../src/db/index.js';
import { buildRoster, deriveLiveness } from '../../src/domain/presence.js';

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
    firstSeen: partial.firstSeen ?? ago(60 * 60 * 1000),
    lastSeen: partial.lastSeen ?? ago(0),
  };
}

describe('deriveLiveness', () => {
  it('is live under the idle threshold', () => {
    expect(deriveLiveness(ago(60 * 1000), NOW)).toBe('live');
  });

  it('is idle between the idle and away thresholds', () => {
    expect(deriveLiveness(ago(10 * 60 * 1000), NOW)).toBe('idle');
  });

  it('is away beyond the away threshold', () => {
    expect(deriveLiveness(ago(60 * 60 * 1000), NOW)).toBe('away');
  });

  it('treats the boundary as the later state (>=)', () => {
    expect(deriveLiveness(ago(5 * 60 * 1000), NOW)).toBe('idle');
    expect(deriveLiveness(ago(30 * 60 * 1000), NOW)).toBe('away');
  });

  it('treats an unparseable timestamp as away', () => {
    expect(deriveLiveness('not-a-date', NOW)).toBe('away');
  });

  it('honours custom thresholds', () => {
    expect(deriveLiveness(ago(2000), NOW, { idleAfterMs: 1000, awayAfterMs: 5000 })).toBe('idle');
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

  it('orders live agents first, then most-recently-seen', () => {
    const roster = buildRoster(
      [
        agent({ agentId: 'away-old', lastSeen: ago(60 * 60 * 1000) }),
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

  it('returns an empty roster when no agents are registered', () => {
    expect(buildRoster([], NOW)).toEqual([]);
  });
});
