import { describe, expect, it } from 'vitest';

import {
  ClaudeStreamingAdapter,
  CodexAppServerAdapter,
  CursorSessionAdapter,
} from '../../src/relay/adapters.js';
import type { AgentSessionDelivery } from '../../src/relay/server.js';

const delivery: AgentSessionDelivery = {
  version: 1,
  type: 'deliver',
  messageId: 'message-1',
  senderAgentId: 'claude:sender',
  recipientAgentId: 'codex:target',
  content: 'Check this now',
  activeTurn: true,
};

describe('provider relay adapters', () => {
  it('uses Codex turn/steer for busy work and turn/start while idle', async () => {
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const adapter = new CodexAppServerAdapter(
      {
        request(method, params) {
          requests.push({ method, params });
          return Promise.resolve({ turnId: 'turn-new' });
        },
      },
      'thread-1',
      () => 'turn-active',
    );

    expect(await adapter.steer(delivery)).toBe('turn-active');
    expect(await adapter.startTurn({ ...delivery, activeTurn: false })).toBe('turn-new');
    expect(requests.map((request) => request.method)).toEqual(['turn/steer', 'turn/start']);
    expect(requests[0]?.params).toMatchObject({ threadId: 'thread-1', turnId: 'turn-active' });
  });

  it.each([
    ['claude', ClaudeStreamingAdapter],
    ['cursor', CursorSessionAdapter],
  ] as const)('%s forwards explicit steer and start modes', async (_provider, adapterClass) => {
    const calls: { content: string; mode: 'steer' | 'start' }[] = [];
    const adapter = new adapterClass({
      pushPrompt(content, mode) {
        calls.push({ content, mode });
        return Promise.resolve(`${mode}-receipt`);
      },
    });

    await adapter.steer(delivery);
    await adapter.startTurn({ ...delivery, activeTurn: false });
    expect(calls).toEqual([
      { content: 'Check this now', mode: 'steer' },
      { content: 'Check this now', mode: 'start' },
    ]);
  });
});
