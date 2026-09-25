import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import type { Repositories } from '../db/index.js';
import {
  decodeRelayDelivery,
  encodeRelayFrame,
  MAX_RELAY_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  type RelayDelivery,
  type RelayResponse,
} from './protocol.js';

export type AgentSessionDelivery = Omit<RelayDelivery, 'credentialProof'>;

export interface AgentSessionAdapter {
  readonly provider: string;
  isBusy(): boolean;
  steer(delivery: AgentSessionDelivery): Promise<string | undefined>;
  inject(delivery: AgentSessionDelivery): Promise<string | undefined>;
}

export interface AgentRelayServerOptions {
  repos: Repositories;
  agentId: string;
  address: string;
  adapter: AgentSessionAdapter;
  ttlMs?: number;
  pullFallback?: boolean;
}

export interface RunningAgentRelay {
  endpointId: string;
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

function socketAcceptingConnections(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(address);
    const finish = (accepting: boolean): void => {
      socket.destroy();
      resolve(accepting);
    };
    socket.setTimeout(250, () => {
      finish(false);
    });
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

async function prepareRelayAddress(address: string): Promise<void> {
  if (process.platform === 'win32' || !existsSync(address)) return;
  if (await socketAcceptingConnections(address)) {
    throw new Error(`A Concord relay is already active at ${address}.`);
  }
  removeUnixSocket(address);
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

function authenticated(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

/** Deterministically spread relay heartbeat phases across one interval. */
export function relayHeartbeatPhaseDelay(endpointId: string, intervalMs: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < endpointId.length; index += 1) {
    hash ^= endpointId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.floor(((hash >>> 0) / 0x1_0000_0000) * intervalMs);
}

/** Host a one-frame, local-only delivery endpoint owned by one live session. */
export async function startAgentRelay(
  options: AgentRelayServerOptions,
): Promise<RunningAgentRelay> {
  if (options.repos.agents.get(options.agentId) === undefined) {
    throw new Error(`Agent ${options.agentId} is not registered.`);
  }
  // Never unlink a live listener. Duplicate SessionStart hooks used to race
  // here: the second host detached the first host's pathname, making whichever
  // process survived impossible to reach even though its endpoint stayed live.
  await prepareRelayAddress(options.address);

  const ttlMs = options.ttlMs ?? 15_000;
  const endpointId = randomUUID();
  const credential = randomBytes(32).toString('base64url');
  const credentialProof = createHash('sha256').update(credential).digest('hex');
  let closed = false;

  const server = createServer((socket) => {
    let buffer = '';
    socket.setTimeout(2_000, () => {
      socket.destroy();
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RELAY_FRAME_BYTES) {
        socket.removeAllListeners('data');
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
          if (!authenticated(delivery.credentialProof, credentialProof)) {
            throw new Error('Relay credential was rejected.');
          }
          if (delivery.recipientAgentId !== options.agentId) {
            throw new Error(`Relay endpoint belongs to ${options.agentId}.`);
          }
          const sessionDelivery: AgentSessionDelivery = {
            version: delivery.version,
            type: delivery.type,
            messageId: delivery.messageId,
            senderAgentId: delivery.senderAgentId,
            recipientAgentId: delivery.recipientAgentId,
            content: delivery.content,
          };
          const deliveryMode = options.adapter.isBusy() ? 'steer' : 'inject';
          const receipt =
            deliveryMode === 'steer'
              ? await options.adapter.steer(sessionDelivery)
              : await options.adapter.inject(sessionDelivery);
          respond(socket, {
            version: RELAY_PROTOCOL_VERSION,
            ok: true,
            provider: options.adapter.provider,
            delivery: deliveryMode,
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
    'local-ipc',
    'inject',
    'steer',
    options.adapter.isBusy() ? 'busy' : 'idle',
    ...(options.pullFallback === true ? ['pull'] : []),
  ];
  const storeEndpoint = (): void => {
    options.repos.agentEndpoints.upsert({
      endpointId,
      agentId: options.agentId,
      provider: options.adapter.provider,
      transport: 'local-ipc',
      capabilities: capabilities(),
      address: options.address,
      credentialHash: credentialProof,
      expiresAt: expiresAt(),
    });
  };
  storeEndpoint();

  const heartbeatIntervalMs = Math.max(1_000, Math.floor(ttlMs / 3));
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const heartbeatOnce = (): void => {
    if (closed) return;
    const current = options.repos.agentEndpoints.getByAgent(options.agentId);
    if (current?.endpointId !== endpointId) {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      closed = true;
      server.close();
      return;
    }
    storeEndpoint();
  };
  const heartbeatStarter = setTimeout(
    () => {
      heartbeatOnce();
      if (closed) return;
      heartbeat = setInterval(heartbeatOnce, heartbeatIntervalMs);
      heartbeat.unref();
    },
    relayHeartbeatPhaseDelay(endpointId, heartbeatIntervalMs),
  );
  heartbeatStarter.unref();

  return {
    endpointId,
    address: options.address,
    close: async () => {
      if (closed) return;
      closed = true;
      clearTimeout(heartbeatStarter);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      const current = options.repos.agentEndpoints.getByAgent(options.agentId);
      const ownsAddress = current?.endpointId === endpointId;
      if (ownsAddress) options.repos.agentEndpoints.disconnect(endpointId);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
      if (ownsAddress) removeUnixSocket(options.address);
    },
  };
}
