import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { OpenCodeRequest } from '../../src/relay/opencode-api.js';
import { OpenCodeServerClient } from '../../src/relay/opencode-client.js';

interface Call {
  method: string;
  path: string;
  body: string | undefined;
}

/** A stand-in for `opencode api`: records calls and serves a mutable active set. */
function fakeApi(): {
  request: OpenCodeRequest;
  calls: Call[];
  active: Set<string>;
  down: boolean;
} {
  const calls: Call[] = [];
  const state = { active: new Set<string>(), down: false };
  const request: OpenCodeRequest = (method, path, body) => {
    calls.push({ method, path, body });
    if (state.down) return Promise.reject(new Error('connection refused'));
    if (path === '/api/session/active') {
      const data = Object.fromEntries([...state.active].map((id) => [id, { type: 'running' }]));
      return Promise.resolve(JSON.stringify({ data }));
    }
    return Promise.resolve(JSON.stringify({ data: { id: 'msg_1' } }));
  };
  return {
    request,
    calls,
    active: state.active,
    get down() {
      return state.down;
    },
    set down(value: boolean) {
      state.down = value;
    },
  };
}

const tick = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('OpenCodeServerClient', () => {
  let client: OpenCodeServerClient | undefined;

  afterEach(() => {
    client?.close();
  });

  it('follows whether the session has a running drain', async () => {
    const api = fakeApi();
    api.active.add('ses_1');
    client = new OpenCodeServerClient({
      request: api.request,
      sessionId: 'ses_1',
      pollEveryMs: 20,
    });
    await client.connect();
    expect(client.isBusy()).toBe(true);

    api.active.delete('ses_1');
    await tick();
    expect(client.isBusy()).toBe(false);
  });

  it('ignores other sessions being active', async () => {
    const api = fakeApi();
    api.active.add('ses_2');
    client = new OpenCodeServerClient({ request: api.request, sessionId: 'ses_1' });
    await client.connect();
    expect(client.isBusy()).toBe(false);
  });

  it('steers with delivery steer and wakes with delivery queue', async () => {
    const api = fakeApi();
    client = new OpenCodeServerClient({ request: api.request, sessionId: 'ses_1' });
    await client.connect();

    expect(await client.pushPrompt('now', 'steer')).toBe('msg_1');
    expect(client.isBusy()).toBe(false);
    await client.pushPrompt('later', 'inject');
    expect(client.isBusy()).toBe(true);

    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts.map((post) => post.path)).toEqual([
      '/api/session/ses_1/prompt',
      '/api/session/ses_1/prompt',
    ]);
    expect(posts.map((post) => z.json().parse(JSON.parse(post.body ?? 'null')))).toEqual([
      { text: 'now', delivery: 'steer' },
      { text: 'later', delivery: 'queue' },
    ]);
  });

  it('rejects when the prompt call fails', async () => {
    const api = fakeApi();
    client = new OpenCodeServerClient({ request: api.request, sessionId: 'ses_1' });
    await client.connect();
    api.down = true;
    await expect(client.pushPrompt('x', 'steer')).rejects.toThrow('connection refused');
  });

  it('fails to connect when the first poll fails', async () => {
    const api = fakeApi();
    api.down = true;
    client = new OpenCodeServerClient({ request: api.request, sessionId: 'ses_1' });
    await expect(client.connect()).rejects.toThrow('connection refused');
  });

  it('notifies closed listeners once the server stops answering', async () => {
    const api = fakeApi();
    client = new OpenCodeServerClient({
      request: api.request,
      sessionId: 'ses_1',
      pollEveryMs: 20,
    });
    await client.connect();
    let closed = false;
    client.onClosed(() => {
      closed = true;
    });
    api.down = true;
    await tick(300);
    expect(closed).toBe(true);
  });
});
