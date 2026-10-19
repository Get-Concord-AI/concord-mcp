import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { type AgentRecord, type AgentStatus, parseAgentRow } from '../rows.js';

/** A registration patch: `undefined` keeps the stored value, `null` clears it. */
export interface NewAgent {
  agentId: string;
  kind: string;
  owner?: string | null | undefined;
  model?: string | null | undefined;
  pid?: number | null | undefined;
  cwd?: string | null | undefined;
  worktree?: string | null | undefined;
  branch?: string | null | undefined;
  summary?: string | null | undefined;
  status?: AgentStatus | undefined;
}

export interface AgentRepository {
  upsert(agent: NewAgent, at?: string): AgentRecord;
  get(agentId: string): AgentRecord | undefined;
  list(): AgentRecord[];
  heartbeat(agentId: string, at?: string): AgentRecord | undefined;
  /** Never changes the reported status, so a `done` agent that keeps writing stays `done`. */
  recordActivity(agentId: string, at?: string): AgentRecord | undefined;
}

const rawListSchema = z.array(z.unknown());

const PATCH_FIELDS = ['owner', 'model', 'pid', 'cwd', 'worktree', 'branch'] as const;

function isSet(value: unknown): number {
  return value === undefined ? 0 : 1;
}

function executionFor(status: AgentStatus): 'executing' | 'not_executing' {
  return status === 'active' ? 'executing' : 'not_executing';
}

function buildUpsertSql(): string {
  const columns = PATCH_FIELDS.join(', ');
  const values = PATCH_FIELDS.map((field) => `@${field}`).join(', ');
  const patches = PATCH_FIELDS.map(
    (field) => `${field} = CASE WHEN @${field}_set = 1 THEN @${field} ELSE agents.${field} END`,
  ).join(',\n      ');
  return `
    INSERT INTO agents (
      agent_id, kind, ${columns}, summary, summary_updated_at, status, execution_status,
      first_seen, last_seen, heartbeat_at
    ) VALUES (
      @agent_id, @kind, ${values}, @summary,
      CASE WHEN @summary IS NULL THEN NULL ELSE @now END, @status, @execution_status,
      @now, @now, @now
    )
    ON CONFLICT(agent_id) DO UPDATE SET
      kind = excluded.kind,
      ${patches},
      summary_updated_at = CASE
        WHEN @summary_set = 1 AND @summary IS NULL THEN NULL
        WHEN @summary_set = 1 AND agents.summary IS NOT @summary THEN @now
        ELSE agents.summary_updated_at
      END,
      summary = CASE WHEN @summary_set = 1 THEN @summary ELSE agents.summary END,
      status = CASE WHEN @status_set = 1 THEN @status ELSE agents.status END,
      execution_status = CASE
        WHEN @status_set = 1 THEN @execution_status ELSE agents.execution_status
      END,
      last_seen = @now,
      heartbeat_at = @now
  `;
}

export function createAgentRepository(db: ConcordDatabase): AgentRepository {
  const upsertStmt = db.prepare(buildUpsertSql());
  const getStmt = db.prepare('SELECT * FROM agents WHERE agent_id = ?');
  const listStmt = db.prepare('SELECT * FROM agents ORDER BY first_seen ASC, agent_id ASC');
  const heartbeatStmt = db.prepare(
    'UPDATE agents SET heartbeat_at = @now, last_seen = @now WHERE agent_id = @agent_id',
  );
  const activityStmt = db.prepare(
    'UPDATE agents SET activity_at = @now, last_seen = @now WHERE agent_id = @agent_id',
  );

  function get(agentId: string): AgentRecord | undefined {
    const raw: unknown = getStmt.get(agentId);
    if (raw === undefined) {
      return undefined;
    }
    return parseAgentRow(raw);
  }

  return {
    upsert(agent, at = new Date().toISOString()) {
      const status = agent.status ?? 'active';
      upsertStmt.run({
        agent_id: agent.agentId,
        kind: agent.kind,
        owner: agent.owner ?? null,
        owner_set: isSet(agent.owner),
        model: agent.model ?? null,
        model_set: isSet(agent.model),
        pid: agent.pid ?? null,
        pid_set: isSet(agent.pid),
        cwd: agent.cwd ?? null,
        cwd_set: isSet(agent.cwd),
        worktree: agent.worktree ?? null,
        worktree_set: isSet(agent.worktree),
        branch: agent.branch ?? null,
        branch_set: isSet(agent.branch),
        summary: agent.summary ?? null,
        summary_set: isSet(agent.summary),
        status,
        status_set: isSet(agent.status),
        execution_status: executionFor(status),
        now: at,
      });
      const stored = get(agent.agentId);
      if (stored === undefined) {
        throw new Error(`Agent ${agent.agentId} could not be read back after upsert`);
      }
      return stored;
    },
    get,
    list() {
      const raw: unknown = listStmt.all();
      return rawListSchema.parse(raw).map(parseAgentRow);
    },
    heartbeat(agentId, at = new Date().toISOString()) {
      heartbeatStmt.run({ agent_id: agentId, now: at });
      return get(agentId);
    },
    recordActivity(agentId, at = new Date().toISOString()) {
      activityStmt.run({ agent_id: agentId, now: at });
      return get(agentId);
    },
  };
}
