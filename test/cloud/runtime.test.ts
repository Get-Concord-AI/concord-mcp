import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  agentCachePath,
  asCloudAgent,
  CloudApiError,
  drainCloud,
  registerCloudAgent,
  toDeliverables,
  type CloudRuntime,
} from '../../src/cloud/runtime.js';

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
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
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    const route = table.get(`${method} ${path}`);
    const { status, json } =
      route === undefined ? { status: 404, json: { error: 'no route' } } : route();
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
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
    const cached: unknown = JSON.parse(readFileSync(agentCachePath(repoRoot), 'utf8'));
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

  it('renders drained messages by the keys agents use, never cloud ids', async () => {
    const cloud = fakeCloud([
      [
        'GET /v1/agents',
        () =>
          ok({
            agents: [
              {
                id: 'sender-uuid',
                agentKey: 'codex:bbbb2222',
                kind: 'codex',
                summary: null,
                status: 'active',
                lastSeenAt: '2026-10-09T10:00:00.000Z',
              },
            ],
          }),
      ],
      ['GET /v1/tasks/task-uuid', () => ok({ task: { taskKey: 'AUTH-12' } })],
    ]);

    const rendered = await toDeliverables(runtimeWith(cloud.fetch), [
      {
        id: 'msg-1',
        senderAgentId: 'sender-uuid',
        taskId: 'task-uuid',
        replyToMessageId: 'msg-0',
        content: 'done',
        createdAt: '2026-10-09T10:00:00.000Z',
        deliveredAt: '2026-10-09T10:00:01.500Z',
      },
    ]);

    expect(rendered).toEqual([
      {
        messageId: 'msg-1',
        senderAgentId: 'codex:bbbb2222',
        taskId: 'AUTH-12',
        content: 'done',
        messageKind: 'reply',
        deliveryLatencyMs: 1500,
      },
    ]);
  });

  it('asks nothing when there is nothing to render', async () => {
    const cloud = fakeCloud([]);

    expect(await toDeliverables(runtimeWith(cloud.fetch), [])).toEqual([]);
    expect(cloud.requests).toEqual([]);
  });
});
