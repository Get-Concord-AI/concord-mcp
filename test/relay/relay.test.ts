import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import {
  startAgentRelay,
  type AgentSessionDelivery,
  type RunningAgentRelay,
} from '../../src/relay/server.js';
import { SocketAgentMessageDispatcher } from '../../src/relay/socket-dispatcher.js';

describe('local agent relay', () => {
  let repos: Repositories;
  let relay: RunningAgentRelay | undefined;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    repos.agents.upsert({
      agentId: 'codex:target',
      kind: 'codex',
      owner: null,
      model: null,
      pid: null,
      cwd: null,
      worktree: null,
      branch: null,
      summary: null,
      status: 'active',
    });
  });

  afterEach(async () => {
    await relay?.close();
  });

  it('uses provider steering while busy and starts a turn while idle', async () => {
    const calls: { mode: 'steer' | 'start'; delivery: AgentSessionDelivery }[] = [];
    let busy = true;
    const address = join(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'agent.sock');
    relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address,
      hasActiveTurn: () => busy,
      adapter: {
        provider: 'codex',
        steer(delivery) {
          calls.push({ mode: 'steer', delivery });
          return Promise.resolve('active-turn');
        },
        startTurn(delivery) {
          calls.push({ mode: 'start', delivery });
          return Promise.resolve('new-turn');
        },
      },
    });
    const endpoint = repos.agentEndpoints.getByAgent('codex:target');
    if (endpoint === undefined) throw new Error('relay endpoint was not registered');
    expect(endpoint.credentialHash).not.toBe(relay.credential);

    const dispatcher = new SocketAgentMessageDispatcher();
    const busyReceipt = await dispatcher.deliver({
      messageId: 'message-busy',
      senderAgentId: 'claude:sender',
      recipientAgentId: 'codex:target',
      content: 'Steer now',
      endpoint,
      activeTurn: true,
    });
    busy = false;
    const idleReceipt = await dispatcher.deliver({
      messageId: 'message-idle',
      senderAgentId: 'claude:sender',
      recipientAgentId: 'codex:target',
      content: 'Start now',
      endpoint,
      activeTurn: false,
    });

    expect(calls.map((call) => call.mode)).toEqual(['steer', 'start']);
    expect(busyReceipt).toEqual({ provider: 'codex', receipt: 'active-turn' });
    expect(idleReceipt).toEqual({ provider: 'codex', receipt: 'new-turn' });
  });

  it('rejects delivery addressed to a different agent', async () => {
    const address = join(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'agent.sock');
    relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address,
      hasActiveTurn: () => true,
      adapter: {
        provider: 'codex',
        steer: () => Promise.resolve(undefined),
        startTurn: () => Promise.resolve(undefined),
      },
    });
    const endpoint = repos.agentEndpoints.getByAgent('codex:target');
    if (endpoint === undefined) throw new Error('relay endpoint was not registered');

    await expect(
      new SocketAgentMessageDispatcher().deliver({
        messageId: 'wrong-target',
        senderAgentId: 'claude:sender',
        recipientAgentId: 'codex:someone-else',
        content: 'Wrong target',
        endpoint,
        activeTurn: true,
      }),
    ).rejects.toThrow('Relay endpoint belongs to codex:target');
  });

  it('never replaces a non-socket path', async () => {
    const address = join(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'keep.txt');
    writeFileSync(address, 'keep me');

    await expect(
      startAgentRelay({
        repos,
        agentId: 'codex:target',
        address,
        hasActiveTurn: () => true,
        adapter: {
          provider: 'codex',
          steer: () => Promise.resolve(undefined),
          startTurn: () => Promise.resolve(undefined),
        },
      }),
    ).rejects.toThrow('Refusing to replace non-socket relay path');
  });
});
