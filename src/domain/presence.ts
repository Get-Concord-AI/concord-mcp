import type { AgentRecord, AgentStatus } from '../db/index.js';

/**
 * Liveness is *derived* from how long ago an agent was last seen — never stored.
 * A registered claim is durable, but presence must decay so a crashed or
 * walked-away agent stops looking active. Distinct from the agent's *reported*
 * status (active/blocked/waiting_review/done), which says what it is doing.
 */
export type Liveness = 'live' | 'idle' | 'away';

/** How long since `last_seen` before an agent is considered idle, then away. */
export interface PresenceThresholds {
  idleAfterMs: number;
  awayAfterMs: number;
}

/** Live under 5 min, idle under 30 min, away beyond. */
export const DEFAULT_PRESENCE_THRESHOLDS: PresenceThresholds = {
  idleAfterMs: 5 * 60 * 1000,
  awayAfterMs: 30 * 60 * 1000,
};

/** A single agent's presence for display in a roster. */
export interface PresenceEntry {
  agentId: string;
  kind: string;
  owner: string | null;
  summary: string | null;
  status: AgentStatus;
  liveness: Liveness;
  lastSeen: string;
  /** Whole seconds since `last_seen`, floored at 0. */
  ageSeconds: number;
}

/** Derive liveness from a `last_seen` ISO timestamp relative to `now` (ms since
 * epoch). Unparseable timestamps are treated as `away`. */
export function deriveLiveness(
  lastSeen: string,
  now: number,
  thresholds: PresenceThresholds = DEFAULT_PRESENCE_THRESHOLDS,
): Liveness {
  const seen = Date.parse(lastSeen);
  if (Number.isNaN(seen)) {
    return 'away';
  }
  const age = now - seen;
  if (age >= thresholds.awayAfterMs) {
    return 'away';
  }
  if (age >= thresholds.idleAfterMs) {
    return 'idle';
  }
  return 'live';
}

const LIVENESS_ORDER: Record<Liveness, number> = { live: 0, idle: 1, away: 2 };

function ageSecondsOf(lastSeen: string, now: number): number {
  const seen = Date.parse(lastSeen);
  if (Number.isNaN(seen)) {
    return 0;
  }
  return Math.max(0, Math.floor((now - seen) / 1000));
}

/**
 * Build the presence roster from registered agents: live agents first, then by
 * most-recently-seen. This is the "who is here and what are they doing" view
 * that other agents read before or while working.
 */
export function buildRoster(
  agents: readonly AgentRecord[],
  now: number,
  thresholds: PresenceThresholds = DEFAULT_PRESENCE_THRESHOLDS,
): PresenceEntry[] {
  return agents
    .map((agent) => ({
      agentId: agent.agentId,
      kind: agent.kind,
      owner: agent.owner,
      summary: agent.summary,
      status: agent.status,
      liveness: deriveLiveness(agent.lastSeen, now, thresholds),
      lastSeen: agent.lastSeen,
      ageSeconds: ageSecondsOf(agent.lastSeen, now),
    }))
    .sort((a, b) => {
      const byLiveness = LIVENESS_ORDER[a.liveness] - LIVENESS_ORDER[b.liveness];
      if (byLiveness !== 0) {
        return byLiveness;
      }
      return b.lastSeen.localeCompare(a.lastSeen);
    });
}
