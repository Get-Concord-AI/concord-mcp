import { describe, expect, it } from 'vitest';

import {
  COPILOT_SERVER_ENV,
  CopilotSessionAdapter,
  copilotLaunchPlan,
  copilotServerAddress,
  supportsUiServer,
} from '../../src/cli/commands/copilot-adapter.js';
import { RELAY_PROTOCOL_VERSION } from '../../src/relay/protocol.js';
import type { AgentSessionDelivery } from '../../src/relay/server.js';

describe('concord adapters copilot (#261)', () => {
  it('starts the TUI with its embedded server and exports the address to hooks', () => {
    const plan = copilotLaunchPlan(47125, ['-i', 'hello'], { PATH: '/bin' });
    expect(plan.args).toEqual(['--ui-server', '--port', '47125', '-i', 'hello']);
    expect(plan.env).toEqual({ PATH: '/bin', [COPILOT_SERVER_ENV]: '127.0.0.1:47125' });
    expect(copilotServerAddress(plan.env)).toBe('127.0.0.1:47125');
  });

  it('leaves plain copilot sessions on hook delivery', () => {
    expect(copilotServerAddress({})).toBeUndefined();
    expect(copilotServerAddress({ [COPILOT_SERVER_ENV]: '  ' })).toBeUndefined();
  });

  it('uses the embedded server only on verified Copilot releases', () => {
    expect(supportsUiServer('GitHub Copilot CLI 1.0.100.')).toBe(true);
    expect(supportsUiServer('GitHub Copilot CLI 1.1.0.')).toBe(true);
    expect(supportsUiServer('GitHub Copilot CLI 1.0.99.')).toBe(false);
    expect(supportsUiServer('not a version')).toBe(false);
  });

  it('hands a relay delivery over as the sender framed it', async () => {
    const pushed: [string, string][] = [];
    const adapter = new CopilotSessionAdapter({
      isBusy: () => true,
      pushPrompt: (content, mode) => {
        pushed.push([content, mode]);
        return Promise.resolve('m-1');
      },
    });
    const delivery: AgentSessionDelivery = {
      version: RELAY_PROTOCOL_VERSION,
      type: 'deliver',
      messageId: 'msg-7',
      senderAgentId: 'peer:tester',
      recipientAgentId: 'copilot-cli:abc',
      content: '[concord from peer:tester id=msg-7]\nthe codeword is FIG-11',
    };
    expect(await adapter.steer(delivery)).toBe('m-1');
    await adapter.inject(delivery);
    expect(pushed).toEqual([
      ['[concord from peer:tester id=msg-7]\nthe codeword is FIG-11', 'steer'],
      ['[concord from peer:tester id=msg-7]\nthe codeword is FIG-11', 'inject'],
    ]);
  });
});
