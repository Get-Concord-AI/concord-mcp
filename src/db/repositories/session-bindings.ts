import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';

/**
 * Which agent a client process hosts now. One row per ancestor pid of the
 * hook that recorded it, because a shell between client and hook shifts the
 * hook's own ppid away from the one the client's MCP servers see.
 *
 * Freshness is bounded by `updated_at`: a server only trusts a binding
 * written while it lived, so a dead session's rows lapse on their own.
 */
export interface SessionBinding {
  clientPid: number;
  agentId: string;
  kind: string;
  updatedAt: string;
}

export interface SessionBindingRepository {
  /** Record that client `clientPid` hosts `agentId`. */
  upsert(clientPid: number, agentId: string, kind: string, at?: string): void;
  /** Drop every binding naming `agentId` — stale rows from dead hook shells. */
  removeForAgent(agentId: string): number;
  /** The binding recorded for one client pid, if any. */
  forClientPid(clientPid: number): SessionBinding | undefined;
}

const bindingRow = z.object({
  client_pid: z.number(),
  agent_id: z.string(),
  kind: z.string(),
  updated_at: z.string(),
});

export function createSessionBindingRepository(db: ConcordDatabase): SessionBindingRepository {
  const upsertStmt = db.prepare(
    `INSERT INTO session_bindings (client_pid, agent_id, kind, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(client_pid) DO UPDATE SET agent_id = excluded.agent_id,
       kind = excluded.kind, updated_at = excluded.updated_at`,
  );
  const removeStmt = db.prepare('DELETE FROM session_bindings WHERE agent_id = ?');
  const getStmt = db.prepare(
    'SELECT client_pid, agent_id, kind, updated_at FROM session_bindings WHERE client_pid = ?',
  );

  return {
    upsert(clientPid, agentId, kind, at = new Date().toISOString()) {
      upsertStmt.run(clientPid, agentId, kind, at);
    },
    removeForAgent(agentId) {
      return removeStmt.run(agentId).changes;
    },
    forClientPid(clientPid) {
      const raw: unknown = getStmt.get(clientPid);
      if (raw === undefined) return undefined;
      const row = bindingRow.parse(raw);
      return {
        clientPid: row.client_pid,
        agentId: row.agent_id,
        kind: row.kind,
        updatedAt: row.updated_at,
      };
    },
  };
}
