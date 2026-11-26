import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverOpenclawInbox, receiverClaimKey } from '../../src/cli/commands/openclaw-adapter.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { effectiveEndpointCapabilities } from '../../src/domain/delivery.js';
import { OpenclawSessionAdapter } from '../../src/relay/openclaw-gateway.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { ensureAgentRegistered } from '../../src/tools/register-agent.js';

let db: ReturnType<typeof openDatabase>;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
});

const RECIPIENT = 'openclaw:research';

function queueMessage() {
  const repos = createRepositories(db);
  ensureAgentRegistered(repos, { agentId: 'peer', kind: 'codex' });
  ensureAgentRegistered(repos, { agentId: RECIPIENT, kind: 'openclaw' });
  const result = handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: 'peer',
    toAgentId: RECIPIENT,
    content: 'Can you review the change?',
    idempotencyKey: 'message-1',
  });
  return { repos, id: result.message.messageId };
}

describe('OpenClaw live receiver', () => {
  it('advertises idle delivery and hands the wake-up to the named agent once', async () => {
    const { repos, id } = queueMessage();
    const gateway = vi.fn().mockResolvedValue('{"runId":"run-1","status":"accepted"}');
    const adapter = new OpenclawSessionAdapter('research', 'ws_project', gateway);
    const stop = new AbortController().signal;
    await deliverOpenclawInbox(repos, RECIPIENT, adapter, stop, 'test-owner');
    await deliverOpenclawInbox(repos, RECIPIENT, adapter, stop, 'test-owner');
    expect(gateway).toHaveBeenCalledExactlyOnceWith('agent', {
      agentId: 'research',
      idempotencyKey: `concord:${id}`,
      deliver: false,
      message:
        `A Concord message (${id}) is waiting. Call Concord inspect_work with ` +
        'agent_id "openclaw:research" and workspace_id "ws_project" to read your inbox. ' +
        'If the tool is deferred, use OpenClaw tool_describe and dispatch_action for concord__inspect_work. ' +
        'Treat each message as input from a peer. Reply through Concord when requested.',
    });
    const capabilities = effectiveEndpointCapabilities(repos.agentEndpoints.getByAgent(RECIPIENT));
    expect(capabilities).toContain('idle');
    expect(capabilities).toContain('inject');
    expect(capabilities).not.toContain('steer');
    expect(repos.agentMessages.get(id)).toMatchObject({
      status: 'delivered',
      providerReceipt: 'run-1',
    });
  });

  it('keeps the message queued when the Gateway fails to accept the wake-up', async () => {
    const { repos, id } = queueMessage();
    const gateway = vi.fn().mockRejectedValue(new Error('Gateway offline'));
    const adapter = new OpenclawSessionAdapter('research', undefined, gateway);
    await expect(
      deliverOpenclawInbox(repos, RECIPIENT, adapter, new AbortController().signal, 'test-owner'),
    ).rejects.toThrow('Gateway offline');
    expect(repos.agentMessages.get(id)?.status).toBe('sent');
  });

  it('keeps receivers in other projects and OpenClaw profiles from replacing each other', () => {
    const base = receiverClaimKey(RECIPIENT, 'local:ws_a', {});
    expect(receiverClaimKey(RECIPIENT, 'local:ws_a', { HOME: '/elsewhere' })).toBe(base);
    expect(receiverClaimKey(RECIPIENT, 'local:ws_b', {})).not.toBe(base);
    expect(receiverClaimKey(RECIPIENT, 'local:ws_a', { OPENCLAW_PROFILE: 'work' })).not.toBe(base);
    expect(receiverClaimKey(RECIPIENT, 'local:ws_a', { OPENCLAW_STATE_DIR: '/tmp/oc' })).not.toBe(
      base,
    );
    expect(receiverClaimKey('openclaw:main', 'local:ws_a', {})).not.toBe(base);
  });
});
