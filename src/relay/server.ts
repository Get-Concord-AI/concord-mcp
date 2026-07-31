import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';

import type { Repositories } from '../db/index.js';
import {
  decodeRelayDelivery,
  encodeRelayFrame,
  MAX_RELAY_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  type RelayDelivery,
  type RelayResponse,
} from './protocol.js';

export interface AgentSessionAdapter {
  readonly provider: string;
  /** Inject into the current turn. Called only when the endpoint reports an active turn. */
  steer(delivery: AgentSessionDelivery): Promise<string | undefined>;
  /** Start a new turn immediately when the endpoint is idle. */
  startTurn(delivery: AgentSessionDelivery): Promise<string | undefined>;
}

export type AgentSessionDelivery = Omit<RelayDelivery, 'credentialProof'>;

export interface AgentRelayServerOptions {
  repos: Repositories;
  agentId: string;
  address: string;
  adapter: AgentSessionAdapter;
  /** Dynamic state supplied by the client integration, not inferred from agent liveness. */
  hasActiveTurn: () => boolean;
  ttlMs?: number;
}

export interface RunningAgentRelay {
  endpointId: string;
  credential: string;
  address: string;
  close(): Promise<void>;
}

function respond(socket: Socket, response: RelayResponse): void {
  socket.end(encodeRelayFrame(response));
}

function removeUnixSocket(address: string): void {
  if (process.platform === 'win32' || !existsSync(address)) return;
  if (!lstatSync(address).isSocket()) {
    throw new Error(`Refusing to replace non-socket relay path: ${address}`);
  }
  unlinkSync(address);
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function toSessionDelivery(delivery: RelayDelivery): AgentSessionDelivery {
  return {
    version: delivery.version,
    type: delivery.type,
    messageId: delivery.messageId,
    senderAgentId: delivery.senderAgentId,
    recipientAgentId: delivery.recipientAgentId,
    content: delivery.content,
    activeTurn: delivery.activeTurn,
  };
}

/**
 * Host a local, one-frame relay for a live client session. The integration that
 * owns the session supplies the provider adapter, so busy-turn steering happens
 * through the provider's supported in-process/app-server API.
 */
export async function startAgentRelay(
  options: AgentRelayServerOptions,
): Promise<RunningAgentRelay> {
  const agent = options.repos.agents.get(options.agentId);
  if (agent === undefined) throw new Error(`Agent ${options.agentId} is not registered.`);
  removeUnixSocket(options.address);

  const ttlMs = options.ttlMs ?? 15_000;
  const endpointId = randomUUID();
  const credential = randomBytes(32).toString('base64url');
  const credentialHash = createHash('sha256').update(credential).digest('hex');
  let closed = false;

  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RELAY_FRAME_BYTES) {
        respond(socket, {
          version: RELAY_PROTOCOL_VERSION,
          ok: false,
          error: 'relay request exceeded maximum frame size',
        });
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.removeAllListeners('data');
      void (async () => {
        try {
          const delivery = decodeRelayDelivery(buffer.slice(0, newline));
          const suppliedProof = Buffer.from(delivery.credentialProof, 'utf8');
          const expectedProof = Buffer.from(credentialHash, 'utf8');
          if (
            suppliedProof.length !== expectedProof.length ||
            !timingSafeEqual(suppliedProof, expectedProof)
          ) {
            throw new Error('Relay credential was rejected.');
          }
          if (delivery.recipientAgentId !== options.agentId) {
            throw new Error(`Relay endpoint belongs to ${options.agentId}.`);
          }
          const sessionDelivery = toSessionDelivery(delivery);
          const activeTurn = options.hasActiveTurn();
          const receipt = activeTurn
            ? await options.adapter.steer({ ...sessionDelivery, activeTurn })
            : await options.adapter.startTurn({ ...sessionDelivery, activeTurn });
          respond(socket, {
            version: RELAY_PROTOCOL_VERSION,
            ok: true,
            provider: options.adapter.provider,
            ...(receipt === undefined ? {} : { receipt }),
          });
        } catch (error) {
          respond(socket, {
            version: RELAY_PROTOCOL_VERSION,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
  });

  await listen(server, options.address);
  if (process.platform !== 'win32') chmodSync(options.address, 0o600);

  const expiresAt = (): string => new Date(Date.now() + ttlMs).toISOString();
  const capabilities = (): string[] => [
    'steer',
    'start-turn',
    ...(options.hasActiveTurn() ? ['active-turn'] : []),
  ];
  options.repos.agentEndpoints.upsert({
    endpointId,
    agentId: options.agentId,
    provider: options.adapter.provider,
    transport: 'local-socket',
    capabilities: capabilities(),
    address: options.address,
    credentialHash,
    expiresAt: expiresAt(),
  });
  const heartbeat = setInterval(
    () => {
      if (closed) return;
      const current = options.repos.agentEndpoints.get(endpointId);
      if (current === undefined) return;
      options.repos.agentEndpoints.upsert({
        endpointId,
        agentId: options.agentId,
        provider: options.adapter.provider,
        transport: 'local-socket',
        capabilities: capabilities(),
        address: options.address,
        credentialHash: current.credentialHash,
        expiresAt: expiresAt(),
      });
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  );
  heartbeat.unref();

  return {
    endpointId,
    credential,
    address: options.address,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      options.repos.agentEndpoints.disconnect(endpointId);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
      removeUnixSocket(options.address);
    },
  };
}
