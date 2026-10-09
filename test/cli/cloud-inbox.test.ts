import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  readAgentState,
  takeDrainKey,
  updateAgentState,
  type CloudRuntime,
} from '../../src/cloud/runtime.js';
import {
  cloudAccess,
  cloudLinked,
  drainFromCloud,
  registerInCloud,
  watchCloud,
} from '../../src/cli/commands/cloud-inbox.js';
import type { DeliverableMessage } from '../../src/domain/pull-inbox.js';
import { fakeCloud, ok, type Route } from '../cloud/fake-cloud.js';

const AGENT = 'claude-code:aaaa1111';
const NOW = new Date().toISOString();

const registering: Route[] = [
  ['POST /v1/machines', () => ok({ machine: { id: 'm-uuid' } })],
  ['POST /v1/agents', () => ok({ agent: { id: 'a-uuid' } })],
  ['PUT /v1/agents/a-uuid/endpoint', () => ok({ endpoint: {} })],
];

function message(content: string) {
  return {
    id: `msg-${content}`,
    senderAgentKey: 'codex:bbbb2222',
    taskKey: null,
    replyToMessageId: null,
    content,
    createdAt: NOW,
    deliveredAt: NOW,
  };
}

describe('cloud inbox', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'concord-cloud-inbox-'));
  });

  function runtimeWith(fetch: CloudRuntime['fetch']): CloudRuntime {
    return {
      apiUrl: 'https://api.example.test',
      bearer: () => Promise.resolve('token'),
      machineKey: 'machine-1',
      repoRoot,
      fetch,
    };
  }

  it('counts a repository as linked only when it has a cloud link', () => {
    expect(cloudLinked(repoRoot, { CONCORD_REPO_ROOT: repoRoot })).toBe(false);
    mkdirSync(join(repoRoot, '.concord'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.concord', 'cloud.json'),
      JSON.stringify({ apiUrl: 'https://api.example.test', projectKey: 'github.com/acme/app' }),
    );
    expect(cloudLinked(repoRoot, { CONCORD_REPO_ROOT: repoRoot })).toBe(true);
  });

  it('drains for a hook in one request once the agent is known', async () => {
    const cloud = fakeCloud([
      ...registering,
      ['POST /v1/messages/drain', () => ok({ messages: [message('hello')] })],
    ]);
    const runtime = runtimeWith(cloud.fetch);
    await drainFromCloud(runtime, AGENT, 'claude-code');
    cloud.requests.length = 0;

    const drained = await drainFromCloud(runtime, AGENT, 'claude-code');

    expect(drained.map((entry) => [entry.senderAgentId, entry.content])).toEqual([
      ['codex:bbbb2222', 'hello'],
    ]);
    expect(cloud.requests.map((request) => request.path)).toEqual(['/v1/messages/drain']);
  });

  it('retries a lost drain with the same key, so its batch is replayed, not lost', async () => {
    let attempts = 0;
    const cloud = fakeCloud([
      ...registering,
      [
        'POST /v1/messages/drain',
        () => {
          attempts += 1;
          return attempts === 1
            ? { status: 503, json: { error: 'busy' } }
            : ok({ messages: [message('kept')] });
        },
      ],
    ]);

    const drained = await drainFromCloud(runtimeWith(cloud.fetch), AGENT, 'claude-code');

    const keys = cloud.requests
      .filter((request) => request.path === '/v1/messages/drain')
      .map((request) => /"drainKey":"([^"]+)"/.exec(JSON.stringify(request.body))?.[1]);
    expect(drained.map((entry) => entry.content)).toEqual(['kept']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('watches by long-polling with a receiver lease, and releases it when done', async () => {
    const cloud = fakeCloud([
      ...registering,
      ['PUT /v1/agents/a-uuid/endpoint/receiver', () => ok({ receiverExpiresAt: NOW })],
      ['DELETE /v1/agents/a-uuid/endpoint/receiver', () => ({ status: 204, json: {} })],
      ['POST /v1/messages/drain', () => ok({ messages: [message('wake up')] })],
    ]);
    const emitted: DeliverableMessage[] = [];

    await watchCloud(runtimeWith(cloud.fetch), AGENT, 'claude-code', true, (messages) =>
      emitted.push(...messages),
    );

    expect(emitted.map((entry) => entry.content)).toEqual(['wake up']);
    const calls = cloud.requests.map((request) => `${request.method} ${request.path}`);
    expect(calls.slice(-3)).toEqual([
      'PUT /v1/agents/a-uuid/endpoint/receiver',
      'POST /v1/messages/drain',
      'DELETE /v1/agents/a-uuid/endpoint/receiver',
    ]);
    const drain = cloud.requests.find((request) => request.path === '/v1/messages/drain');
    expect(drain?.body).toMatchObject({ waitSeconds: 25 });
    const endpoint = cloud.requests.find(
      (request) => request.path === '/v1/agents/a-uuid/endpoint',
    );
    expect(JSON.stringify(endpoint?.body)).toContain('idle');
  });

  it('reports a linked repository this machine cannot use, instead of failing', () => {
    mkdirSync(join(repoRoot, '.concord'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.concord', 'cloud.json'),
      JSON.stringify({ apiUrl: 'https://api.example.test', projectKey: 'github.com/acme/app' }),
    );
    const home = mkdtempSync(join(tmpdir(), 'concord-home-'));

    const access = cloudAccess(repoRoot, {}, { CONCORD_REPO_ROOT: repoRoot, HOME: home });

    expect(access).toMatchObject({ kind: 'unusable' });
  });

  it('keeps a running monitor’s idle reach, and its lease, when the session registers', async () => {
    const cloud = fakeCloud([
      ...registering,
      ['PUT /v1/agents/a-uuid/endpoint/receiver', () => ok({ receiverExpiresAt: NOW })],
    ]);
    const runtime = runtimeWith(cloud.fetch);
    await registerInCloud(runtime, AGENT, 'cursor', repoRoot);
    updateAgentState(runtime, AGENT, { watchingUntil: Date.now() + 60_000 });
    cloud.requests.length = 0;

    await registerInCloud(runtime, AGENT, 'cursor', repoRoot);

    expect(cloud.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'PUT /v1/agents/a-uuid/endpoint',
      'PUT /v1/agents/a-uuid/endpoint/receiver',
    ]);
    expect(JSON.stringify(cloud.requests[0]?.body)).toContain('idle');
  });

  it('keeps a drain key whose answer never came, and replays it on the next drain', async () => {
    let failing = true;
    const cloud = fakeCloud([
      ...registering,
      [
        'POST /v1/messages/drain',
        () =>
          failing ? { status: 503, json: { error: 'down' } } : ok({ messages: [message('late')] }),
      ],
    ]);
    const runtime = runtimeWith(cloud.fetch);

    await expect(drainFromCloud(runtime, AGENT, 'claude-code')).rejects.toMatchObject({
      status: 503,
    });
    failing = false;
    const drained = await drainFromCloud(runtime, AGENT, 'claude-code');

    const keys = cloud.requests
      .filter((request) => request.path === '/v1/messages/drain')
      .map((request) => /"drainKey":"([^"]+)"/.exec(JSON.stringify(request.body))?.[1]);
    expect(new Set(keys).size).toBe(1);
    expect(drained.map((entry) => entry.content)).toEqual(['late']);
    // Answered, so the next drain starts afresh.
    expect(takeDrainKey(runtime, AGENT).replay).toBe(false);
  });

  it('advertises the endpoint when a hook drain is the first to register the session', async () => {
    const cloud = fakeCloud([
      ...registering,
      ['POST /v1/messages/drain', () => ok({ messages: [] })],
    ]);

    await drainFromCloud(runtimeWith(cloud.fetch), AGENT, 'claude-code');

    expect(cloud.requests.map((request) => `${request.method} ${request.path}`)).toContain(
      'PUT /v1/agents/a-uuid/endpoint',
    );
  });

  it('stops watching on a failure retrying cannot fix, such as a lapsed login', async () => {
    const cloud = fakeCloud(registering);
    const runtime: CloudRuntime = {
      ...runtimeWith(cloud.fetch),
      bearer: () => Promise.reject(new Error('Your Concord Cloud login has expired.')),
    };

    await expect(watchCloud(runtime, AGENT, 'claude-code', false, () => undefined)).rejects.toThrow(
      'login has expired',
    );
  });

  it('registers again when advertising a new registration failed', async () => {
    let failEndpoint = true;
    const cloud = fakeCloud([
      ['POST /v1/machines', () => ok({ machine: { id: 'm-uuid' } })],
      ['POST /v1/agents', () => ok({ agent: { id: 'a-uuid' } })],
      [
        'PUT /v1/agents/a-uuid/endpoint',
        () => (failEndpoint ? { status: 503, json: { error: 'down' } } : ok({ endpoint: {} })),
      ],
      ['POST /v1/messages/drain', () => ok({ messages: [] })],
    ]);
    const runtime = runtimeWith(cloud.fetch);

    await expect(drainFromCloud(runtime, AGENT, 'claude-code')).rejects.toMatchObject({
      status: 503,
    });
    failEndpoint = false;
    cloud.requests.length = 0;
    await drainFromCloud(runtime, AGENT, 'claude-code');

    expect(cloud.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /v1/machines',
      'POST /v1/agents',
      'PUT /v1/agents/a-uuid/endpoint',
      'POST /v1/messages/drain',
    ]);
  });

  it('keeps no ids from a registration it could not advertise', async () => {
    const cloud = fakeCloud([
      ['POST /v1/machines', () => ok({ machine: { id: 'm-uuid' } })],
      ['POST /v1/agents', () => ok({ agent: { id: 'a-uuid' } })],
      ['PUT /v1/agents/a-uuid/endpoint', () => ({ status: 503, json: { error: 'down' } })],
    ]);
    const runtime = runtimeWith(cloud.fetch);

    await expect(registerInCloud(runtime, AGENT, 'claude-code', repoRoot)).rejects.toMatchObject({
      status: 503,
    });

    expect(readAgentState(runtime, AGENT)).toBeUndefined();
  });

  it('gives a hook one deadline for everything, retries included', async () => {
    // A cloud that never answers until the request is abandoned.
    const hanging = (_input: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          // The timeout's own reason, so the drain sees a timeout and retries.
          const reason = z.instanceof(Error).safeParse(init.signal?.reason);
          reject(reason.success ? reason.data : new Error('aborted'));
        });
      });
    const runtime: CloudRuntime = { ...runtimeWith(hanging), deadline: Date.now() + 300 };
    const started = Date.now();

    await expect(drainFromCloud(runtime, AGENT, 'claude-code')).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('holds a token refresh to the hook’s deadline too', async () => {
    const runtime: CloudRuntime = {
      ...runtimeWith(fakeCloud(registering).fetch),
      bearer: () => new Promise<string>(() => undefined),
      deadline: Date.now() + 200,
    };
    const started = Date.now();

    await expect(drainFromCloud(runtime, AGENT, 'claude-code')).rejects.toThrow('in time');

    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
