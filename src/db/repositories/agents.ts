import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { type AgentRecord, type AgentStatus, parseAgentRow } from '../rows.js';

/** A registration payload. Optional fields are explicit `null`. `agentId` is
 * supplied by the caller (generated once per session and reused). */
export interface NewAgent {
  agentId: string;
  kind: string;
  owner: string | null;
  model: string | null;
  pid: number | null;
  cwd: string | null;
  worktree: string | null;
  branch: string | null;
  summary: string | null;
  status: AgentStatus;
}

export interface AgentRepository {
  /** Insert or refresh an agent. On re-registration the mutable fields and
   * `last_seen` are updated while `first_seen` is preserved. */
  upsert(agent: NewAgent): AgentRecord;
  get(agentId: string): AgentRecord | undefined;
  list(): AgentRecord[];
  /** Bump `last_seen` to now so an agent stays present just by doing work.
   * Returns undefined if the agent has never registered. */
  touch(agentId: string): AgentRecord | undefined;
}

const rawListSchema = z.array(z.unknown());

export function createAgentRepository(db: ConcordDatabase): AgentRepository {
  const upsertStmt = db.prepare(`
    INSERT INTO agents (
      agent_id, kind, owner, model, pid, cwd, worktree, branch, summary, status,
      first_seen, last_seen
    ) VALUES (
      @agent_id, @kind, @owner, @model, @pid, @cwd, @worktree, @branch, @summary, @status,
      @now, @now
    )
    ON CONFLICT(agent_id) DO UPDATE SET
      kind = excluded.kind,
      owner = excluded.owner,
      model = excluded.model,
      pid = excluded.pid,
      cwd = excluded.cwd,
      worktree = excluded.worktree,
      branch = excluded.branch,
      summary = excluded.summary,
      status = excluded.status,
      last_seen = excluded.last_seen
  `);
  const getStmt = db.prepare('SELECT * FROM agents WHERE agent_id = ?');
  const listStmt = db.prepare('SELECT * FROM agents ORDER BY first_seen ASC, agent_id ASC');
  const touchStmt = db.prepare('UPDATE agents SET last_seen = @now WHERE agent_id = @agent_id');

  function get(agentId: string): AgentRecord | undefined {
    const raw: unknown = getStmt.get(agentId);
    if (raw === undefined) {
      return undefined;
    }
    return parseAgentRow(raw);
  }

  return {
    upsert(agent) {
      const now = new Date().toISOString();
      upsertStmt.run({
        agent_id: agent.agentId,
        kind: agent.kind,
        owner: agent.owner,
        model: agent.model,
        pid: agent.pid,
        cwd: agent.cwd,
        worktree: agent.worktree,
        branch: agent.branch,
        summary: agent.summary,
        status: agent.status,
        now,
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
    touch(agentId) {
      touchStmt.run({ agent_id: agentId, now: new Date().toISOString() });
      return get(agentId);
    },
  };
}
