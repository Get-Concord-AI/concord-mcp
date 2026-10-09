import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  agentCachePath,
  asCloudAgent,
  CloudApiError,
  connectPullEndpoint,
  drainCloud,
  registerCloudAgent,
  releaseReceiver,
  renewReceiver,
  toDeliverables,
  type CloudRuntime,
} from '../../src/cloud/runtime.js';

type JsonValue = z.infer<ReturnType<typeof z.json>>;

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: JsonValue;
}

interface Reply {
  readonly status: number;
  readonly json: object;
}
type Route = readonly [string, () => Reply];
const ok = (json: object): Reply => ({ status: 200, json });

/** A Concord Cloud that answers from `routes` ("METHOD /path"), recording every request. */
function fakeCloud(routes: readonly Route[]) {
  const table = new Map(routes);
  const requests: Recorded[] = [];
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = new URL(input).pathname;
    const body = typeof init?.body === 'string' ? z.json().parse(JSON.parse(init.body)) : null;
    requests.push({ method, path, body });
    const route = table.get(`${method} ${path}`);
    const { status, json } =
      route === undefined ? { status: 404, json: { error: 'no route' } } : route();
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(json), { status }));
  };
  return { fetch, requests };
}

const REGISTRATION = { agentKey: 'claude-code:aaaa1111', kind: 'claude-code' };

describe('cloud runtime', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'concord-runtime-'));
  });

  function runtimeWith(fetch: CloudRuntime['fetch'], machineKey = 'machine-1'): CloudRuntime {
    return {
      apiUrl: 'https://api.example.test',
      bearer: () => Promise.resolve('token'),
      machineKey,
      repoRoot,
      fetch,
    };
  }

  const registering: Route[] = [
    ['POST /v1/machines', () => ok({ machine: { id: 'm-uuid' } })],
    ['POST /v1/agents', () => ok({ agent: { id: 'a-uuid' } })],
  ];

  it('registers the machine, then the agent on it, and caches both ids', async () => {
    const cloud = fakeCloud(registering);

    const ref = await registerCloudAgent(runtimeWith(cloud.fetch), REGISTRATION);

    expect(ref).toEqual({ agentId: 'a-uuid', machineId: 'm-uuid' });
    expect(cloud.requests.map((request) => request.path)).toEqual(['/v1/machines', '/v1/agents']);
    expect(cloud.requests[0]?.body).toMatchObject({ machineKey: 'machine-1' });
    expect(cloud.requests[1]?.body).toMatchObject({
      agentKey: REGISTRATION.agentKey,
      kind: 'claude-code',
      machineId: 'm-uuid',
    });
    const cached = z.json().parse(JSON.parse(readFileSync(agentCachePath(repoRoot), 'utf8')));
    expect(cached).toMatchObject({ agents: { [REGISTRATION.agentKey]: ref } });
  });

  it('acts from the cache without registering again', async () => {
    const cloud = fakeCloud(registering);
    const runtime = runtimeWith(cloud.fetch);
    await registerCloudAgent(runtime, REGISTRATION);
    cloud.requests.length = 0;

    const seen = await asCloudAgent(runtime, REGISTRATION, (agent) =>
      Promise.resolve(agent.agentId),
    );

    expect(seen).toBe('a-uuid');
    expect(cloud.requests).toEqual([]);
  });

  it('registers again, once, when the cloud no longer knows the cached agent', async () => {
    const cloud = fakeCloud(registering);
    const runtime = runtimeWith(cloud.fetch);
    await registerCloudAgent(runtime, REGISTRATION);
    let attempts = 0;

    const result = await asCloudAgent(runtime, REGISTRATION, () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new CloudApiError(404, 'gone'))
        : Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('ignores ids cached for another machine', async () => {
    const cloud = fakeCloud(registering);
    await registerCloudAgent(runtimeWith(cloud.fetch, 'machine-1'), REGISTRATION);
    cloud.requests.length = 0;

    await asCloudAgent(runtimeWith(cloud.fetch, 'machine-2'), REGISTRATION, () =>
      Promise.resolve(),
    );

    expect(cloud.requests.map((request) => request.path)).toEqual(['/v1/machines', '/v1/agents']);
  });

  it('drains with its key, waiting no longer than the cloud allows', async () => {
    const cloud = fakeCloud([['POST /v1/messages/drain', () => ok({ messages: [] })]]);

    await drainCloud(
      runtimeWith(cloud.fetch),
      { agentId: 'a-uuid', machineId: 'm-uuid' },
      'k1',
      60,
    );

    expect(cloud.requests[0]?.body).toEqual({ agentId: 'a-uuid', drainKey: 'k1', waitSeconds: 25 });
  });

  it('reports a refusal with its status', async () => {
    const cloud = fakeCloud([
      ['POST /v1/messages/drain', () => ({ status: 403, json: { error: 'no' } })],
    ]);

    const failure = drainCloud(runtimeWith(cloud.fetch), { agentId: 'a', machineId: 'm' }, 'k');

    await expect(failure).rejects.toMatchObject({ status: 403 });
  });

  it('renders drained messages by the keys the drain returns, asking nothing more', () => {
    const rendered = toDeliverables([
      {
        id: 'msg-1',
        senderAgentKey: 'codex:bbbb2222',
        taskKey: 'AUTH-12',
        replyToMessageId: 'msg-0',
        content: 'done',
        createdAt: '2026-10-09T10:00:01.500Z',
        deliveredAt: '2026-10-09T10:00:00.000Z',
      },
    ]);

    expect(rendered).toEqual([
      {
        messageId: 'msg-1',
        senderAgentId: 'codex:bbbb2222',
        taskId: 'AUTH-12',
        content: 'done',
        messageKind: 'reply',
        // A clock skew between machines never shows as negative latency.
        deliveryLatencyMs: 0,
      },
    ]);
  });

  it('passes on a refusal for an agent the cloud still has, without registering again', async () => {
    const cloud = fakeCloud([
      ...registering,
      ['GET /v1/agents/a-uuid', () => ok({ agent: { id: 'a-uuid' } })],
    ]);
    const runtime = runtimeWith(cloud.fetch);
    await registerCloudAgent(runtime, REGISTRATION);
    cloud.requests.length = 0;

    const refused = asCloudAgent(runtime, REGISTRATION, () =>
      Promise.reject(new CloudApiError(404, 'no endpoint')),
    );

    await expect(refused).rejects.toMatchObject({ status: 404 });
    expect(cloud.requests.map((request) => request.path)).toEqual(['/v1/agents/a-uuid']);
  });

  it('asks for a whole number of seconds the cloud accepts', async () => {
    const cloud = fakeCloud([['POST /v1/messages/drain', () => ok({ messages: [] })]]);

    await drainCloud(runtimeWith(cloud.fetch), { agentId: 'a', machineId: 'm' }, 'k', 2.7);

    expect(cloud.requests[0]?.body).toMatchObject({ waitSeconds: 2 });
  });

  it('advertises a pull endpoint, then holds and lets go of the receiver lease', async () => {
    const cloud = fakeCloud([
      ['PUT /v1/agents/a-uuid/endpoint', () => ok({ endpoint: {} })],
      ['PUT /v1/agents/a-uuid/endpoint/receiver', () => ok({ receiverExpiresAt: null })],
      ['DELETE /v1/agents/a-uuid/endpoint/receiver', () => ({ status: 204, json: {} })],
    ]);
    const runtime = runtimeWith(cloud.fetch);
    const agent = { agentId: 'a-uuid', machineId: 'm-uuid' };

    await connectPullEndpoint(runtime, agent, REGISTRATION.agentKey, 'claude-code', [
      'pull',
      'idle',
    ]);
    await renewReceiver(runtime, agent, 90);
    await releaseReceiver(runtime, agent);

    expect(cloud.requests).toEqual([
      {
        method: 'PUT',
        path: '/v1/agents/a-uuid/endpoint',
        body: {
          provider: 'claude-code',
          transport: 'pull',
          capabilities: ['pull', 'idle'],
          address: `pull:${REGISTRATION.agentKey}`,
          credentialHash: 'none',
        },
      },
      { method: 'PUT', path: '/v1/agents/a-uuid/endpoint/receiver', body: { ttlSeconds: 90 } },
      { method: 'DELETE', path: '/v1/agents/a-uuid/endpoint/receiver', body: null },
    ]);
  });
});
