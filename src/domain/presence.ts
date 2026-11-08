import type { AgentExecutionStatus, AgentRecord, AgentStatus, TaskRecord } from '../db/index.js';

/**
 * Liveness is *derived* from how long ago an agent was last seen — never stored.
 * A registered claim is durable, but presence must decay so a crashed or
 * walked-away agent stops looking active. Distinct from the agent's *reported*
 * status (active/blocked/waiting_review/done), which says what it is doing.
 * Agent records are never deleted: an agent unseen for long enough becomes
 * `archived` and drops off the roster, but its id and history remain.
 */
export type Liveness = 'live' | 'idle' | 'away' | 'archived';

/** How long since `last_seen` before an agent is considered idle, away, then
 * archived. */
export interface PresenceThresholds {
  idleAfterMs: number;
  awayAfterMs: number;
  archiveAfterMs: number;
}

/** Live under 5 min, idle under 30 min, away under 1 h, archived beyond. */
export const DEFAULT_PRESENCE_THRESHOLDS: PresenceThresholds = {
  idleAfterMs: 5 * 60 * 1000,
  awayAfterMs: 30 * 60 * 1000,
  archiveAfterMs: 60 * 60 * 1000,
};

/** A single agent's presence for display in a roster. */
export interface PresenceEntry {
  agentId: string;
  kind: string;
  owner: string | null;
  summary: string | null;
  status: AgentStatus;
  executionStatus: AgentExecutionStatus;
  liveness: Liveness;
  lastSeen: string;
  /** Whole seconds since `last_seen`, floored at 0. */
  ageSeconds: number;
  heartbeatAt: string;
  heartbeatLiveness: Liveness;
  heartbeatAgeSeconds: number;
  activityAt: string | null;
  activityAgeSeconds: number | null;
  summaryUpdatedAt: string | null;
  summaryAgeSeconds: number | null;
}

/** Derive liveness from a `last_seen` ISO timestamp relative to `now` (ms since
 * epoch). Unparseable timestamps are treated as `archived` — an agent whose
 * last activity cannot be read must not sit on the roster forever. */
export function deriveLiveness(
  lastSeen: string,
  now: number,
  thresholds: PresenceThresholds = DEFAULT_PRESENCE_THRESHOLDS,
): Liveness {
  const seen = Date.parse(lastSeen);
  if (Number.isNaN(seen)) {
    return 'archived';
  }
  const age = now - seen;
  if (age >= thresholds.archiveAfterMs) {
    return 'archived';
  }
  if (age >= thresholds.awayAfterMs) {
    return 'away';
  }
  if (age >= thresholds.idleAfterMs) {
    return 'idle';
  }
  return 'live';
}

const LIVENESS_ORDER: Record<Liveness, number> = { live: 0, idle: 1, away: 2, archived: 3 };

function ageSecondsOf(lastSeen: string, now: number): number {
  const seen = Date.parse(lastSeen);
  if (Number.isNaN(seen)) {
    return 0;
  }
  return Math.max(0, Math.floor((now - seen) / 1000));
}

function optionalAgeSecondsOf(timestamp: string | null, now: number): number | null {
  return timestamp === null ? null : ageSecondsOf(timestamp, now);
}

export function presenceEntryOf(
  agent: AgentRecord,
  now: number,
  thresholds: PresenceThresholds = DEFAULT_PRESENCE_THRESHOLDS,
): PresenceEntry {
  return {
    agentId: agent.agentId,
    kind: agent.kind,
    owner: agent.owner,
    summary: agent.summary,
    status: agent.status,
    executionStatus: agent.executionStatus,
    liveness: deriveLiveness(agent.lastSeen, now, thresholds),
    lastSeen: agent.lastSeen,
    ageSeconds: ageSecondsOf(agent.lastSeen, now),
    heartbeatAt: agent.heartbeatAt,
    heartbeatLiveness: deriveLiveness(agent.heartbeatAt, now, thresholds),
    heartbeatAgeSeconds: ageSecondsOf(agent.heartbeatAt, now),
    activityAt: agent.activityAt,
    activityAgeSeconds: optionalAgeSecondsOf(agent.activityAt, now),
    summaryUpdatedAt: agent.summaryUpdatedAt,
    summaryAgeSeconds: optionalAgeSecondsOf(agent.summaryUpdatedAt, now),
  };
}

export interface StaleClaim {
  taskId: string;
  title: string;
  agentId: string;
  /** Why it is stale: the agent is `away`, or was never seen (unregistered). */
  reason: 'agent-away' | 'agent-unregistered';
  /** Seconds since the owning agent was last seen, or null when unregistered. */
  ageSeconds: number | null;
}

/**
 * Flag active claims whose owning agent has gone away — the "agent walked off
 * without handing off" case a durable claim alone cannot surface. Only claims
 * carrying an `agentId` are assessed; unattributed claims are left alone (they
 * predate presence and would be noise). A claim is stale when its agent is
 * `away` or `archived`, or when the referenced agent never registered.
 */
export function detectStaleClaims(
  tasks: readonly TaskRecord[],
  agents: readonly AgentRecord[],
  now: number,
  thresholds: PresenceThresholds = DEFAULT_PRESENCE_THRESHOLDS,
): StaleClaim[] {
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
  const stale: StaleClaim[] = [];
  for (const task of tasks) {
    if (!['active', 'blocked', 'handoff_offered'].includes(task.status) || task.agentId === null) {
      continue;
    }
    const agent = byId.get(task.agentId);
    if (agent === undefined) {
      stale.push({
        taskId: task.taskId,
        title: task.title,
        agentId: task.agentId,
        reason: 'agent-unregistered',
        ageSeconds: null,
      });
    } else if (
      LIVENESS_ORDER[deriveLiveness(agent.lastSeen, now, thresholds)] >= LIVENESS_ORDER.away
    ) {
      stale.push({
        taskId: task.taskId,
        title: task.title,
        agentId: task.agentId,
        reason: 'agent-away',
        ageSeconds: ageSecondsOf(agent.lastSeen, now),
      });
    }
  }
  return stale;
}

/**
 * Build the presence roster from registered agents: live agents first, then by
 * most-recently-seen. This is the "who is here and what are they doing" view
 * that other agents read before or while working. Archived agents are omitted
 * — they stay registered forever, they just no longer appear here.
 */
export function buildRoster(
  agents: readonly AgentRecord[],
  now: number,
  thresholds: PresenceThresholds = DEFAULT_PRESENCE_THRESHOLDS,
): PresenceEntry[] {
  return agents
    .map((agent) => presenceEntryOf(agent, now, thresholds))
    .filter((entry) => entry.liveness !== 'archived')
    .sort((a, b) => {
      const byLiveness = LIVENESS_ORDER[a.liveness] - LIVENESS_ORDER[b.liveness];
      if (byLiveness !== 0) {
        return byLiveness;
      }
      return b.lastSeen.localeCompare(a.lastSeen);
    });
}
