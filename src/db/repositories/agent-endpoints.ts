import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import {
  parseAgentEndpointRow,
  serializeStringArray,
  type AgentEndpointRecord,
  type AgentEndpointStatus,
} from '../rows.js';

export interface NewAgentEndpoint {
  endpointId: string;
  agentId: string;
  provider: string;
  transport: string;
  capabilities: readonly string[];
  address: string;
  credentialHash: string;
  status?: AgentEndpointStatus;
  expiresAt?: string | null;
}

export interface AgentEndpointRepository {
  upsert(endpoint: NewAgentEndpoint): AgentEndpointRecord;
  get(endpointId: string): AgentEndpointRecord | undefined;
  getByAgent(agentId: string): AgentEndpointRecord | undefined;
  list(): AgentEndpointRecord[];
  heartbeat(endpointId: string, expiresAt?: string | null): AgentEndpointRecord | undefined;
  heartbeatReceiver(
    endpointId: string,
    expiresAt: string,
    owner?: string,
  ): AgentEndpointRecord | undefined;
  clearReceiver(endpointId: string, owner?: string): AgentEndpointRecord | undefined;
  /**
   * Record that `agentId`'s session stopped to wait on its user (`since`), or
   * moved on (`null`). Keeps the first timestamp of an ongoing wait.
   */
  setAwaitingUser(agentId: string, since: string | null): void;
  /**
   * A hook denied `session`'s question at `grantedAt` to show it messages
   * first, so its next question is let through. Drops this agent's allowances
   * granted before `expiredBefore`, which no question will spend in time.
   */
  grantUserWaitAllowance(
    agentId: string,
    session: string | null,
    grantedAt: string,
    expiredBefore: string,
  ): void;
  /** Spend `session`'s allowance: when it was granted, or undefined if it has none. */
  takeUserWaitAllowance(agentId: string, session: string | null): string | undefined;
  disconnect(endpointId: string): AgentEndpointRecord | undefined;
}

const rawListSchema = z.array(z.unknown());
const allowanceRowSchema = z.object({ granted_at: z.string() });

/** SQLite never treats two NULLs in a primary key as equal, so no session is ''. */
function sessionColumn(session: string | null): string {
  return session ?? '';
}

export function createAgentEndpointRepository(db: ConcordDatabase): AgentEndpointRepository {
  const upsertStmt = db.prepare(`
    INSERT INTO agent_endpoints (
      endpoint_id, agent_id, provider, transport, capabilities, address,
      credential_hash, status, last_seen, expires_at, created_at, updated_at
    ) VALUES (
      @endpoint_id, @agent_id, @provider, @transport, @capabilities, @address,
      @credential_hash, @status, @now, @expires_at, @now, @now
    )
    ON CONFLICT(agent_id) DO UPDATE SET
      endpoint_id = excluded.endpoint_id,
      provider = excluded.provider,
      transport = excluded.transport,
      capabilities = excluded.capabilities,
      address = excluded.address,
      credential_hash = excluded.credential_hash,
      status = excluded.status,
      last_seen = excluded.last_seen,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `);
  const getStmt = db.prepare('SELECT * FROM agent_endpoints WHERE endpoint_id = ?');
  const getByAgentStmt = db.prepare('SELECT * FROM agent_endpoints WHERE agent_id = ?');
  const listStmt = db.prepare('SELECT * FROM agent_endpoints ORDER BY created_at, endpoint_id');
  const heartbeatStmt = db.prepare(`
    UPDATE agent_endpoints
    SET status = 'connected', last_seen = @now, expires_at = @expires_at, updated_at = @now
    WHERE endpoint_id = @endpoint_id
  `);
  const disconnectStmt = db.prepare(`
    UPDATE agent_endpoints
    SET status = 'disconnected', updated_at = @now
    WHERE endpoint_id = @endpoint_id
  `);
  const heartbeatReceiverStmt = db.prepare(`
    UPDATE agent_endpoints
    SET receiver_expires_at = @receiver_expires_at, receiver_owner = @receiver_owner,
        updated_at = @now
    WHERE endpoint_id = @endpoint_id
  `);
  const setAwaitingUserStmt = db.prepare(`
    UPDATE agent_endpoints
    SET awaiting_user_since = CASE
      WHEN @since IS NULL THEN NULL
      ELSE COALESCE(awaiting_user_since, @since)
    END
    WHERE agent_id = @agent_id
  `);
  const grantAllowanceStmt = db.prepare(`
    INSERT INTO user_wait_allowances (agent_id, session, granted_at)
    VALUES (@agent_id, @session, @granted_at)
    ON CONFLICT(agent_id, session) DO UPDATE SET granted_at = excluded.granted_at
  `);
  const pruneAllowancesStmt = db.prepare(`
    DELETE FROM user_wait_allowances WHERE agent_id = @agent_id AND granted_at < @before
  `);
  const getAllowanceStmt = db.prepare(`
    SELECT granted_at FROM user_wait_allowances WHERE agent_id = @agent_id AND session = @session
  `);
  const deleteAllowanceStmt = db.prepare(`
    DELETE FROM user_wait_allowances WHERE agent_id = @agent_id AND session = @session
  `);
  const grantAllowance = db.transaction(
    (agentId: string, session: string, grantedAt: string, expiredBefore: string) => {
      pruneAllowancesStmt.run({ agent_id: agentId, before: expiredBefore });
      grantAllowanceStmt.run({ agent_id: agentId, session, granted_at: grantedAt });
    },
  );
  const takeAllowance = db.transaction((agentId: string, session: string) => {
    const raw: unknown = getAllowanceStmt.get({ agent_id: agentId, session });
    if (raw === undefined) return undefined;
    deleteAllowanceStmt.run({ agent_id: agentId, session });
    return allowanceRowSchema.parse(raw).granted_at;
  });
  const clearReceiverStmt = db.prepare(`
    UPDATE agent_endpoints
    SET receiver_expires_at = NULL, receiver_owner = NULL, updated_at = @now
    WHERE endpoint_id = @endpoint_id
  `);
  const clearReceiverOwnedStmt = db.prepare(`
    UPDATE agent_endpoints
    SET receiver_expires_at = NULL, receiver_owner = NULL, updated_at = @now
    WHERE endpoint_id = @endpoint_id AND receiver_owner = @owner
  `);

  function get(endpointId: string): AgentEndpointRecord | undefined {
    const raw: unknown = getStmt.get(endpointId);
    return raw === undefined ? undefined : parseAgentEndpointRow(raw);
  }

  function getByAgent(agentId: string): AgentEndpointRecord | undefined {
    const raw: unknown = getByAgentStmt.get(agentId);
    return raw === undefined ? undefined : parseAgentEndpointRow(raw);
  }

  return {
    upsert(endpoint) {
      const now = new Date().toISOString();
      upsertStmt.run({
        endpoint_id: endpoint.endpointId,
        agent_id: endpoint.agentId,
        provider: endpoint.provider,
        transport: endpoint.transport,
        capabilities: serializeStringArray(endpoint.capabilities),
        address: endpoint.address,
        credential_hash: endpoint.credentialHash,
        status: endpoint.status ?? 'connected',
        expires_at: endpoint.expiresAt ?? null,
        now,
      });
      const stored = getByAgent(endpoint.agentId);
      if (stored === undefined) {
        throw new Error(`Agent endpoint ${endpoint.endpointId} could not be read back`);
      }
      return stored;
    },
    get,
    getByAgent,
    list() {
      const raw: unknown = listStmt.all();
      return rawListSchema.parse(raw).map(parseAgentEndpointRow);
    },
    heartbeat(endpointId, expiresAt = null) {
      heartbeatStmt.run({
        endpoint_id: endpointId,
        expires_at: expiresAt,
        now: new Date().toISOString(),
      });
      return get(endpointId);
    },
    heartbeatReceiver(endpointId, expiresAt, owner) {
      heartbeatReceiverStmt.run({
        endpoint_id: endpointId,
        receiver_expires_at: expiresAt,
        receiver_owner: owner ?? null,
        now: new Date().toISOString(),
      });
      return get(endpointId);
    },
    clearReceiver(endpointId, owner) {
      if (owner === undefined) {
        clearReceiverStmt.run({ endpoint_id: endpointId, now: new Date().toISOString() });
      } else {
        clearReceiverOwnedStmt.run({
          endpoint_id: endpointId,
          owner,
          now: new Date().toISOString(),
        });
      }
      return get(endpointId);
    },
    setAwaitingUser(agentId, since) {
      setAwaitingUserStmt.run({ agent_id: agentId, since });
    },
    grantUserWaitAllowance(agentId, session, grantedAt, expiredBefore) {
      grantAllowance(agentId, sessionColumn(session), grantedAt, expiredBefore);
    },
    takeUserWaitAllowance(agentId, session) {
      return takeAllowance(agentId, sessionColumn(session));
    },
    disconnect(endpointId) {
      disconnectStmt.run({ endpoint_id: endpointId, now: new Date().toISOString() });
      return get(endpointId);
    },
  };
}
