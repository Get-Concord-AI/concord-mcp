import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentCachePath, updateAgentState, type CloudRuntime } from '../../src/cloud/runtime.js';
import { deliverToSession } from '../../src/cli/commands/cloud-codex.js';
import type { DeliverableMessage } from '../../src/domain/pull-inbox.js';
import type { AgentSessionAdapter, AgentSessionDelivery } from '../../src/relay/server.js';
import { fakeCloud, ok } from '../cloud/fake-cloud.js';

const AGENT = 'codex:aaaa1111';

function message(id: string, content: string): DeliverableMessage {
  return {
    messageId: id,
    senderAgentId: 'claude-code:bbbb2222',
    taskId: null,
    content,
    messageKind: 'prompt',
    deliveryLatencyMs: 0,
  };
}

/** A Codex session that records what it was handed, and how. */
function session(busy: boolean, failing = false) {
  const handed: { mode: 'steer' | 'inject'; delivery: AgentSessionDelivery }[] = [];
  const take =
    (mode: 'steer' | 'inject') =>
    (delivery: AgentSessionDelivery): Promise<string | undefined> => {
      if (failing) return Promise.reject(new Error('no turn to steer'));
      handed.push({ mode, delivery });
      return Promise.resolve('turn-1');
    };
  const adapter: AgentSessionAdapter = {
    provider: 'codex',
    isBusy: () => busy,
    steer: take('steer'),
    inject: take('inject'),
  };
  return { adapter, handed };
}

function runtimeWith(fetch: CloudRuntime['fetch']): CloudRuntime {
  const repoRoot = mkdtempSync(join(tmpdir(), 'concord-codex-'));
  return {
    apiUrl: 'https://api.example.test',
    bearer: () => Promise.resolve('token'),
    machineKey: 'machine-1',
    projectKey: 'github.com/acme/app',
    repoRoot,
    checkoutRoot: repoRoot,
    fetch,
  };
}

describe('Codex in a linked repository', () => {
  it('starts a turn for a message when Codex is idle, framed with who wrote it', async () => {
    const { adapter, handed } = session(false);

    await deliverToSession(runtimeWith(fakeCloud([]).fetch), AGENT, adapter, [
      message('m-1', 'please review'),
    ]);

    expect(handed).toHaveLength(1);
    expect(handed[0]?.mode).toBe('inject');
    expect(handed[0]?.delivery.content).toBe(
      '[concord from claude-code:bbbb2222 id=m-1]\nplease review',
    );
  });

  it('steers the turn under way when Codex is busy, one message at a time', async () => {
    const { adapter, handed } = session(true);

    await deliverToSession(runtimeWith(fakeCloud([]).fetch), AGENT, adapter, [
      message('m-1', 'first'),
      message('m-2', 'second'),
    ]);

    expect(handed.map((entry) => [entry.mode, entry.delivery.messageId])).toEqual([
      ['steer', 'm-1'],
      ['steer', 'm-2'],
    ]);
  });

  it('records a message Codex would not take as failed, so its sender knows', async () => {
    const cloud = fakeCloud([['POST /v1/messages/m-1/failure', () => ok({ message: {} })]]);
    const runtime = runtimeWith(cloud.fetch);
    updateAgentState(runtime, AGENT, { agentId: 'a-uuid', machineId: 'm-uuid' });

    await deliverToSession(runtime, AGENT, session(true, true).adapter, [message('m-1', 'hi')]);

    expect(cloud.requests).toEqual([
      {
        method: 'POST',
        path: '/v1/messages/m-1/failure',
        body: {
          agentId: 'a-uuid',
          errorCode: 'target_not_promptable',
          errorDetail: 'no turn to steer',
        },
      },
    ]);
  });

  /** A session that never answers, as a wedged app-server would not. */
  const stalled: AgentSessionAdapter = {
    provider: 'codex',
    isBusy: () => false,
    steer: () => new Promise<string | undefined>(() => undefined),
    inject: () => new Promise<string | undefined>(() => undefined),
  };

  it('ends a handoff in progress when the host stops, and says it may not have arrived', async () => {
    const cloud = fakeCloud([['POST /v1/messages/m-1/failure', () => ok({ message: {} })]]);
    const runtime = runtimeWith(cloud.fetch);
    updateAgentState(runtime, AGENT, { agentId: 'a-uuid', machineId: 'm-uuid' });
    const stop = new AbortController();
    setTimeout(() => {
      stop.abort();
    }, 50);

    await deliverToSession(runtime, AGENT, stalled, [message('m-1', 'hi')], stop.signal);

    expect(JSON.stringify(cloud.requests[0]?.body)).toContain('may not have arrived');
  });

  it('hands nothing more to Codex once stopped, and reports the rest as not delivered', async () => {
    const cloud = fakeCloud([
      ['POST /v1/messages/m-1/failure', () => ok({ message: {} })],
      ['POST /v1/messages/m-2/failure', () => ok({ message: {} })],
    ]);
    const runtime = runtimeWith(cloud.fetch);
    updateAgentState(runtime, AGENT, { agentId: 'a-uuid', machineId: 'm-uuid' });
    const { adapter, handed } = session(false);
    const stop = new AbortController();
    stop.abort();

    await deliverToSession(
      runtime,
      AGENT,
      adapter,
      [message('m-1', 'one'), message('m-2', 'two')],
      stop.signal,
    );

    expect(handed).toEqual([]);
    expect(cloud.requests.map((request) => request.path)).toEqual([
      '/v1/messages/m-1/failure',
      '/v1/messages/m-2/failure',
    ]);
  });

  it('keeps a failure report the cloud could not take, and makes it next time', async () => {
    let down = true;
    const cloud = fakeCloud([
      [
        'POST /v1/messages/m-1/failure',
        () => (down ? { status: 503, json: { error: 'down' } } : ok({ message: {} })),
      ],
    ]);
    const runtime = runtimeWith(cloud.fetch);
    updateAgentState(runtime, AGENT, { agentId: 'a-uuid', machineId: 'm-uuid' });

    await deliverToSession(runtime, AGENT, session(true, true).adapter, [message('m-1', 'hi')]);
    const saved = agentCachePath(runtime.repoRoot, AGENT).replace(/\.json$/, '.unreported');
    expect(readdirSync(saved)).toHaveLength(1);
    down = false;
    await deliverToSession(runtime, AGENT, session(false).adapter, []);

    expect(readdirSync(saved)).toHaveLength(0);
    expect(cloud.requests).toHaveLength(2);
  });
});
