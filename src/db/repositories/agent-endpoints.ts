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
  heartbeatReceiver(endpointId: string, expiresAt: string): AgentEndpointRecord | undefined;
  clearReceiver(endpointId: string): AgentEndpointRecord | undefined;
  disconnect(endpointId: string): AgentEndpointRecord | undefined;
}

const rawListSchema = z.array(z.unknown());

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
    SET receiver_expires_at = @receiver_expires_at, updated_at = @now
    WHERE endpoint_id = @endpoint_id
  `);
  const clearReceiverStmt = db.prepare(`
    UPDATE agent_endpoints
    SET receiver_expires_at = NULL, updated_at = @now
    WHERE endpoint_id = @endpoint_id
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
    heartbeatReceiver(endpointId, expiresAt) {
      heartbeatReceiverStmt.run({
        endpoint_id: endpointId,
        receiver_expires_at: expiresAt,
        now: new Date().toISOString(),
      });
      return get(endpointId);
    },
    clearReceiver(endpointId) {
      clearReceiverStmt.run({ endpoint_id: endpointId, now: new Date().toISOString() });
      return get(endpointId);
    },
    disconnect(endpointId) {
      disconnectStmt.run({ endpoint_id: endpointId, now: new Date().toISOString() });
      return get(endpointId);
    },
  };
}
