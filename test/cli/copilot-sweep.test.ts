import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CopilotSessionAdapter,
  SWEEP_AFTER_MS,
  sweepStragglers,
} from '../../src/cli/commands/copilot-adapter.js';
import { openDatabase } from '../../src/db/connection.js';
import { registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

const AGENT = 'copilot-cli:host';

function send(repos: Repositories, content: string, key: string): string {
  return handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: 'peer',
    toAgentId: AGENT,
    content,
    idempotencyKey: key,
  }).message.messageId;
}

describe('sweepStragglers (#261)', () => {
  let repos: Repositories;
  let pushed: string[];
  let fail: boolean;
  let adapter: CopilotSessionAdapter;
  const later = (): number => Date.now() + SWEEP_AFTER_MS + 1_000;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    handleRegisterAgent(repos, { agent_id: AGENT, kind: 'copilot-cli' });
    handleRegisterAgent(repos, { agent_id: 'peer', kind: 'claude-code' });
    registerPullEndpoint(repos, AGENT, 'copilot-cli');
    pushed = [];
    fail = false;
    adapter = new CopilotSessionAdapter({
      isBusy: () => false,
      pushPrompt: (content) => {
        if (fail) return Promise.reject(new Error('TUI gone'));
        pushed.push(content);
        return Promise.resolve('m');
      },
    });
  });

  it('hands over a message whose push never reached the host, framed', async () => {
    send(repos, 'Missed by the push.', 'k-1');
    await sweepStragglers(repos, AGENT, adapter, later());
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatch(/^\[concord from peer id=[^\]]+\]\nMissed by the push\.$/u);
  });

  it('never hands over twice a message the host already pushed', async () => {
    const id = send(repos, 'Pushed late, after the sender gave up.', 'k-2');
    adapter.handled.add(id);
    await sweepStragglers(repos, AGENT, adapter, later());
    expect(pushed).toEqual([]);
    expect(repos.agentMessages.get(id)?.status).toBe('delivered');
  });

  it('leaves messages young enough for a push still in flight', async () => {
    const id = send(repos, 'Being pushed right now.', 'k-3');
    await sweepStragglers(repos, AGENT, adapter, Date.now());
    expect(pushed).toEqual([]);
    expect(repos.agentMessages.get(id)?.status).toBe('sent');
  });

  it('claims nothing it could not hand over, so the next sweep retries it', async () => {
    const id = send(repos, 'Copilot was momentarily unavailable.', 'k-4');
    fail = true;
    await sweepStragglers(repos, AGENT, adapter, later());
    expect(repos.agentMessages.get(id)?.status).toBe('sent');

    fail = false;
    await sweepStragglers(repos, AGENT, adapter, later());
    expect(repos.agentMessages.get(id)?.status).toBe('delivered');
    expect(pushed).toHaveLength(1);
  });

  it('never repeats a handoff when only recording it failed', async () => {
    const id = send(repos, 'Accepted, but the database was busy.', 'k-5');
    vi.spyOn(repos.agentMessages, 'markDelivered').mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY');
    });
    await expect(sweepStragglers(repos, AGENT, adapter, later())).rejects.toThrow('SQLITE_BUSY');
    expect(repos.agentMessages.get(id)?.status).toBe('sent');

    await sweepStragglers(repos, AGENT, adapter, later());
    expect(pushed).toHaveLength(1);
    expect(repos.agentMessages.get(id)?.status).toBe('delivered');
  });

  it('reads only messages waiting for the session', () => {
    const waiting = send(repos, 'Waiting.', 'k-6');
    registerPullEndpoint(repos, 'peer', 'claude-code');
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: AGENT,
      toAgentId: 'peer',
      content: 'Sent by the session itself.',
      idempotencyKey: 'k-7',
    });
    repos.agentMessages.markDelivered(
      send(repos, 'Already delivered.', 'k-8'),
      'copilot-cli',
      null,
    );
    expect(repos.agentMessages.listPendingForRecipient(AGENT).map((m) => m.messageId)).toEqual([
      waiting,
    ]);
  });
});
