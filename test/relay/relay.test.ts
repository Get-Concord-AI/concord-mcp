import { mkdtempSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { relayAddress } from '../../src/relay/address.js';
import { CodexAppServerAdapter } from '../../src/relay/adapters.js';
import {
  decodeRelayResponse,
  encodeRelayFrame,
  type RelayDelivery,
  type RelayResponse,
} from '../../src/relay/protocol.js';
import {
  relayHeartbeatPhaseDelay,
  startAgentRelay,
  type AgentSessionDelivery,
} from '../../src/relay/server.js';
import { SocketAgentMessageDispatcher } from '../../src/relay/socket-dispatcher.js';
import { renderPeerMessage } from '../../src/domain/pull-inbox.js';
import { registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import {
  handleSendAgentMessage,
  handleSendAgentMessageWithDelivery,
} from '../../src/tools/agent-messages.js';

function register(repos: Repositories, agentId: string): void {
  repos.agents.upsert({
    agentId,
    kind: agentId.split(':')[0] ?? 'agent',
    owner: null,
    model: null,
    pid: null,
    cwd: null,
    worktree: null,
    branch: null,
    summary: null,
    status: 'active',
  });
}

async function listen(server: Server, address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function relayResult(address: string, frame: RelayDelivery): Promise<RelayResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    const chunks: Buffer[] = [];
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    });
    socket.once('end', () => {
      resolve(decodeRelayResponse(Buffer.concat(chunks).toString('utf8').trim()));
    });
    socket.once('connect', () => {
      socket.end(encodeRelayFrame(frame));
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

describe('relay heartbeat phase spreading', () => {
  it('is deterministic, bounded, and separates endpoint phases', () => {
    const intervalMs = 5_000;
    const endpointIds = ['endpoint-a', 'endpoint-b', 'endpoint-c', 'endpoint-d'];
    const delays = endpointIds.map((endpointId) =>
      relayHeartbeatPhaseDelay(endpointId, intervalMs),
    );

    expect(relayHeartbeatPhaseDelay('endpoint-a', intervalMs)).toBe(delays[0]);
    expect(delays.every((delay) => delay >= 0 && delay < intervalMs)).toBe(true);
    expect(new Set(delays).size).toBeGreaterThan(2);
  });
});

describe('local IPC relay', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    register(repos, 'codex:sender');
    register(repos, 'codex:target');
  });

  it('injects an idle recipient and records the provider receipt', async () => {
    const deliveries: AgentSessionDelivery[] = [];
    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address: relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target'),
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.reject(new Error('not busy')),
        inject: (delivery) => {
          deliveries.push(delivery);
          return Promise.resolve('turn-new');
        },
      },
    });

    try {
      const result = await handleSendAgentMessageWithDelivery(
        repos,
        {
          operation: 'prompt',
          agentId: 'codex:sender',
          toAgentId: 'codex:target',
          content: 'Start reviewing now.',
          idempotencyKey: 'inject-1',
        },
        new SocketAgentMessageDispatcher(),
      );

      expect(result.delivery).toBe('delivered');
      expect(result.immediateMode).toBe('inject');
      expect(result.message.providerReceipt).toBe('turn-new');

      // Framed like every other channel, so the woken session can reply.
      expect(deliveries[0]?.content).toBe(
        `[concord from codex:sender id=${result.message.messageId}]\nStart reviewing now.`,
      );
    } finally {
      await relay.close();
    }
  });

  it('preserves multibyte request content when a frame spans socket writes', async () => {
    const deliveries: AgentSessionDelivery[] = [];
    const address = relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target');
    const content = 'namaste  café 東京';
    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address,
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.reject(new Error('not busy')),
        inject: (delivery) => {
          deliveries.push(delivery);
          return Promise.resolve('turn-utf8');
        },
      },
    });

    try {
      const endpoint = repos.agentEndpoints.getByAgent('codex:target');
      if (endpoint === undefined) throw new Error('Relay endpoint was not registered.');
      const pending = handleSendAgentMessage(repos, {
        operation: 'prompt',
        agentId: 'codex:sender',
        toAgentId: 'codex:target',
        content,
        idempotencyKey: 'utf8-request-1',
      });

      const request: RelayDelivery = {
        version: 1,
        type: 'deliver',
        messageId: pending.message.messageId,
        senderAgentId: 'codex:sender',
        recipientAgentId: 'codex:target',
        credentialProof: endpoint.credentialHash,
        content,
      };
      const frame = Buffer.from(encodeRelayFrame(request), 'utf8');
      const splitAt = frame.indexOf(Buffer.from('東', 'utf8')) + 1;
      const response = await new Promise<Buffer>((resolve, reject) => {
        const socket = createConnection(address);
        const responseChunks: Buffer[] = [];
        socket.on('data', (chunk) => {
          if (Buffer.isBuffer(chunk)) {
            responseChunks.push(chunk);
          }
        });
        socket.once('error', reject);
        socket.once('end', () => {
          resolve(Buffer.concat(responseChunks));
        });
        socket.once('connect', () => {
          socket.write(frame.subarray(0, splitAt));
          setTimeout(() => {
            socket.write(frame.subarray(splitAt));
          }, 10);
        });
      });

      expect(response.toString('utf8')).toContain('"ok":true');
      expect(deliveries[0]?.content).toBe(renderPeerMessage(pending.message));
      expect(deliveries[0]?.content).not.toContain('\uFFFD');
    } finally {
      await relay.close();
    }
  });

  it('injects the stored message and rejects a frame with no pending row', async () => {
    const deliveries: AgentSessionDelivery[] = [];
    const address = relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target');
    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address,
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.reject(new Error('not busy')),
        inject: (delivery) => {
          deliveries.push(delivery);
          return Promise.resolve('turn-stored');
        },
      },
    });

    try {
      const endpoint = repos.agentEndpoints.getByAgent('codex:target');
      if (endpoint === undefined) throw new Error('Relay endpoint was not registered.');
      const proof = endpoint.credentialHash;
      const forged = await relayResult(address, {
        version: 1,
        type: 'deliver',
        messageId: 'not-a-row',
        senderAgentId: 'alice',
        recipientAgentId: 'codex:target',
        credentialProof: proof,
        content: 'CANARY-DO-NOT-RUN',
      });
      expect(forged).toEqual({
        version: 1,
        ok: false,
        error: 'Relay delivery has no pending message.',
      });
      expect(deliveries).toEqual([]);

      const pending = handleSendAgentMessage(repos, {
        operation: 'prompt',
        agentId: 'codex:sender',
        toAgentId: 'codex:target',
        content: 'stored body',
        idempotencyKey: 'stored-1',
      });
      const accepted = await relayResult(address, {
        version: 1,
        type: 'deliver',
        messageId: pending.message.messageId,
        senderAgentId: 'someone-else',
        recipientAgentId: 'codex:target',
        credentialProof: proof,
        content: 'CANARY-DO-NOT-RUN',
      });
      expect(accepted.ok).toBe(true);
      expect(deliveries.map((delivery) => delivery.senderAgentId)).toEqual(['codex:sender']);
      expect(deliveries.map((delivery) => delivery.content)).toEqual([
        renderPeerMessage(pending.message),
      ]);

      repos.agentMessages.markDelivered(pending.message.messageId, 'codex', 'turn-stored');
      const replay = await relayResult(address, {
        version: 1,
        type: 'deliver',
        messageId: pending.message.messageId,
        senderAgentId: 'codex:sender',
        recipientAgentId: 'codex:target',
        credentialProof: proof,
        content: 'stored body',
      });
      expect(replay).toEqual({
        version: 1,
        ok: false,
        error: 'Relay delivery has no pending message.',
      });
      expect(deliveries).toHaveLength(1);

      const wrongProof = await relayResult(address, {
        version: 1,
        type: 'deliver',
        messageId: pending.message.messageId,
        senderAgentId: 'codex:sender',
        recipientAgentId: 'codex:target',
        credentialProof: 'wrong-proof',
        content: 'stored body',
      });
      expect(wrongProof).toEqual({
        version: 1,
        ok: false,
        error: 'Relay credential was rejected.',
      });
    } finally {
      await relay.close();
    }
  });

  it('preserves multibyte relay responses split across socket chunks', async () => {
    const address = relayAddress(
      mkdtempSync(join(tmpdir(), 'concord-relay-response-')),
      'codex:target',
    );
    const response = Buffer.from(
      encodeRelayFrame({
        version: 1,
        ok: true,
        provider: '東京',
        delivery: 'inject',
        receipt: 'turn-café',
      }),
      'utf8',
    );
    const splitAt = response.indexOf(Buffer.from('東', 'utf8')) + 1;
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write(response.subarray(0, splitAt));
        setTimeout(() => {
          socket.end(response.subarray(splitAt));
        }, 10);
      });
    });
    await listen(server, address);

    try {
      const endpoint = repos.agentEndpoints.upsert({
        endpointId: 'utf8-response-endpoint',
        agentId: 'codex:target',
        provider: 'codex',
        transport: 'local-ipc',
        capabilities: ['local-ipc'],
        address,
        credentialHash: 'unused-by-response-server',
      });
      const message = handleSendAgentMessage(repos, {
        operation: 'prompt',
        agentId: 'codex:sender',
        toAgentId: 'codex:target',
        content: 'Read this response.',
        idempotencyKey: 'utf8-response-1',
      }).message;

      await expect(
        new SocketAgentMessageDispatcher().deliver({ endpoint, message }),
      ).resolves.toEqual({
        provider: '東京',
        delivery: 'inject',
        receipt: 'turn-café',
      });
    } finally {
      await closeServer(server);
    }
  });

  it('does not inject the same message twice when a delivery is retried', async () => {
    const deliveries: AgentSessionDelivery[] = [];

    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address: relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target'),
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.resolve('steered'),
        inject: (delivery) => {
          deliveries.push(delivery);
          return Promise.resolve(`turn-${String(deliveries.length)}`);
        },
      },
    });

    try {
      const result = handleSendAgentMessage(repos, {
        operation: 'prompt',
        agentId: 'codex:sender',
        toAgentId: 'codex:target',
        content: 'Test duplicate delivery.',
        idempotencyKey: 'relay-dedup-1',
      });

      const endpoint = repos.agentEndpoints.getByAgent('codex:target');

      if (endpoint === undefined) {
        throw new Error('Relay endpoint was not registered.');
      }

      const dispatcher = new SocketAgentMessageDispatcher();
      const request = {
        endpoint,
        message: result.message,
      };

      // Simulate the sender retrying the exact same delivery.
      const firstReceipt = await dispatcher.deliver(request);
      const secondReceipt = await dispatcher.deliver(request);

      expect(firstReceipt).toEqual(secondReceipt);
      expect(firstReceipt.receipt).toBe('turn-1');
      expect(deliveries).toHaveLength(1);
    } finally {
      await relay.close();
    }
  });

  it('does not inject the same message twice when deliveries arrive concurrently', async () => {
    const deliveries: AgentSessionDelivery[] = [];

    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address: relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target'),
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.resolve('steered'),
        inject: async (delivery) => {
          deliveries.push(delivery);

          // Keep the first delivery in flight while the concurrent retry arrives.
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });

          return `turn-${String(deliveries.length)}`;
        },
      },
    });

    try {
      const result = handleSendAgentMessage(repos, {
        operation: 'prompt',
        agentId: 'codex:sender',
        toAgentId: 'codex:target',
        content: 'Test concurrent duplicate delivery.',
        idempotencyKey: 'relay-concurrent-dedup-1',
      });

      const endpoint = repos.agentEndpoints.getByAgent('codex:target');

      if (endpoint === undefined) {
        throw new Error('Relay endpoint was not registered.');
      }

      const dispatcher = new SocketAgentMessageDispatcher();
      const request = {
        endpoint,
        message: result.message,
      };

      // Both requests arrive while the first adapter invocation is in flight.
      const [firstReceipt, secondReceipt] = await Promise.all([
        dispatcher.deliver(request),
        dispatcher.deliver(request),
      ]);

      expect(firstReceipt).toEqual(secondReceipt);
      expect(firstReceipt.receipt).toBe('turn-1');
      expect(deliveries).toHaveLength(1);
    } finally {
      await relay.close();
    }
  });

  it('enforces the delivery cache limit without evicting pending deliveries', async () => {
    const pendingResolvers: ((receipt: string) => void)[] = [];
    let deliveryCount = 0;

    let resolveTwoDeliveries: (() => void) | undefined;
    let resolveThirdDelivery: (() => void) | undefined;

    const twoDeliveriesStarted = new Promise<void>((resolve) => {
      resolveTwoDeliveries = resolve;
    });

    const thirdDeliveryStarted = new Promise<void>((resolve) => {
      resolveThirdDelivery = resolve;
    });

    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address: relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target'),
      maxCachedDeliveries: 2,
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.reject(new Error('not busy')),
        inject: () => {
          deliveryCount += 1;

          if (deliveryCount === 2) {
            resolveTwoDeliveries?.();
          }

          if (deliveryCount === 3) {
            resolveThirdDelivery?.();
          }

          return new Promise<string>((resolve) => {
            pendingResolvers.push(resolve);
          });
        },
      },
    });

    try {
      const endpoint = repos.agentEndpoints.getByAgent('codex:target');

      if (endpoint === undefined) {
        throw new Error('Relay endpoint was not registered.');
      }

      const dispatcher = new SocketAgentMessageDispatcher(10_000);

      const createMessage = (idempotencyKey: string) =>
        handleSendAgentMessage(repos, {
          operation: 'prompt',
          agentId: 'codex:sender',
          toAgentId: 'codex:target',
          content: `Message ${idempotencyKey}`,
          idempotencyKey,
        }).message;

      const firstMessage = createMessage('cache-pending-1');
      const secondMessage = createMessage('cache-pending-2');

      const firstRequest = { endpoint, message: firstMessage };
      const secondRequest = { endpoint, message: secondMessage };

      const firstDelivery = dispatcher.deliver(firstRequest);
      const secondDelivery = dispatcher.deliver(secondRequest);

      // Wait until both cache entries are pending.
      await twoDeliveriesStarted;

      // A retry of an existing message must reuse its pending promise.
      const duplicateDelivery = dispatcher.deliver(firstRequest);

      // A distinct third message must be rejected while both entries are pending.
      const thirdMessage = createMessage('cache-pending-3');

      await expect(dispatcher.deliver({ endpoint, message: thirdMessage })).rejects.toThrow(
        /cache is full/i,
      );

      expect(deliveryCount).toBe(2);

      // Completing one delivery frees capacity.
      const resolveFirst = pendingResolvers[0];

      if (resolveFirst === undefined) {
        throw new Error('First delivery resolver was not registered.');
      }

      resolveFirst('turn-1');

      const [firstReceipt, duplicateReceipt] = await Promise.all([
        firstDelivery,
        duplicateDelivery,
      ]);

      expect(firstReceipt).toEqual(duplicateReceipt);
      expect(firstReceipt.receipt).toBe('turn-1');

      // A new distinct delivery can now enter the cache.
      const fourthMessage = createMessage('cache-pending-4');
      const fourthDelivery = dispatcher.deliver({ endpoint, message: fourthMessage });

      await thirdDeliveryStarted;

      const resolveThird = pendingResolvers[2];

      if (resolveThird === undefined) {
        throw new Error('Third delivery resolver was not registered.');
      }

      resolveThird('turn-3');

      await expect(fourthDelivery).resolves.toMatchObject({
        provider: 'codex',
        delivery: 'inject',
        receipt: 'turn-3',
      });

      expect(deliveryCount).toBe(3);

      // Finish the remaining pending delivery.
      const resolveSecond = pendingResolvers[1];

      if (resolveSecond === undefined) {
        throw new Error('Second delivery resolver was not registered.');
      }

      resolveSecond('turn-2');

      await expect(secondDelivery).resolves.toMatchObject({
        receipt: 'turn-2',
      });
    } finally {
      // Ensure no adapter promises are left pending if an assertion fails.
      for (const resolve of pendingResolvers) {
        resolve('cleanup');
      }

      await relay.close();
    }
  });

  it('uses Codex expectedTurnId when steering an active turn', async () => {
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const adapter = new CodexAppServerAdapter(
      {
        request(method, params) {
          requests.push({ method, params });
          return Promise.resolve({});
        },
      },
      'thread-1',
      () => 'turn-7',
    );

    await adapter.steer({
      version: 1,
      type: 'deliver',
      messageId: 'm1',
      senderAgentId: 'a',
      recipientAgentId: 'b',
      content: 'Use the new constraint.',
    });

    expect(requests).toEqual([
      {
        method: 'turn/steer',
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-7',
          input: [{ type: 'text', text: 'Use the new constraint.' }],
          clientUserMessageId: 'm1',
        },
      },
    ]);
  });

  it('keeps push routing when a lifecycle hook refreshes the pull fallback', async () => {
    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address: relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target'),
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.resolve('steered'),
        inject: () => Promise.resolve('injected'),
      },
      pullFallback: true,
    });

    try {
      registerPullEndpoint(repos, 'codex:target', 'codex');
      expect(repos.agentEndpoints.getByAgent('codex:target')).toMatchObject({
        transport: 'local-ipc',
      });
      expect(repos.agentEndpoints.getByAgent('codex:target')?.capabilities).toContain('pull');
    } finally {
      await relay.close();
    }
  });

  it('refuses a duplicate host without unlinking the live relay', async () => {
    const deliveries: AgentSessionDelivery[] = [];
    const address = relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target');
    const adapter = {
      provider: 'codex',
      isBusy: () => false,
      steer: () => Promise.resolve('steered'),
      inject: (delivery: AgentSessionDelivery) => {
        deliveries.push(delivery);
        return Promise.resolve('injected');
      },
    };
    const relay = await startAgentRelay({ repos, agentId: 'codex:target', address, adapter });

    try {
      await expect(
        startAgentRelay({ repos, agentId: 'codex:target', address, adapter }),
      ).rejects.toThrow(/already active/i);

      const result = await handleSendAgentMessageWithDelivery(
        repos,
        {
          operation: 'prompt',
          agentId: 'codex:sender',
          toAgentId: 'codex:target',
          content: 'Still reachable.',
          idempotencyKey: 'duplicate-host-1',
        },
        new SocketAgentMessageDispatcher(),
      );

      expect(result.delivery).toBe('delivered');
      expect(deliveries.map((delivery) => delivery.content)).toEqual([
        `[concord from codex:sender id=${result.message.messageId}]\nStill reachable.`,
      ]);
    } finally {
      await relay.close();
    }
  });

  it('keeps a message queued when immediate delivery fails but pull is available', async () => {
    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address: relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target'),
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.reject(new Error('offline')),
        inject: () => Promise.reject(new Error('offline')),
      },
      pullFallback: true,
    });

    try {
      const result = await handleSendAgentMessageWithDelivery(
        repos,
        {
          operation: 'prompt',
          agentId: 'codex:sender',
          toAgentId: 'codex:target',
          content: 'Retry through the inbox.',
          idempotencyKey: 'fallback-1',
        },
        new SocketAgentMessageDispatcher(),
      );

      expect(result.delivery).toBe('queued_pull');
      expect(result.message.status).toBe('sent');
      expect(result.outlook).toMatch(/remains queued/i);
    } finally {
      await relay.close();
    }
  });
});
