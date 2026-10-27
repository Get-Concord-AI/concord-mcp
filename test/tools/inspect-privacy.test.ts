import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { drainInbox, registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleInspectWork } from '../../src/tools/workflow.js';

function registerAgent(repos: Repositories, agentId: string): void {
  repos.agents.upsert({
    agentId,
    kind: 'claude-code',
    owner: null,
    model: null,
    pid: null,
    cwd: null,
    worktree: null,
    branch: null,
    summary: null,
    status: 'active',
  });
}

function send(repos: Repositories, from: string, to: string, key: string): string {
  return handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: from,
    toAgentId: to,
    content: `${from} to ${to}`,
    idempotencyKey: key,
  }).message.messageId;
}

describe('inbox privacy', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    for (const agent of ['alpha', 'beta', 'gamma']) {
      registerAgent(repos, agent);
      registerPullEndpoint(repos, agent, 'claude-code');
    }
  });

  it('shows another agent only as presence, never its inbox or outbox', () => {
    send(repos, 'beta', 'gamma', 'k1');
    const result = handleInspectWork(repos, { agent_id: 'beta' }, 'alpha');

    expect(result.scope).toBe('agent');
    if (result.scope !== 'agent') return;
    expect(result.communication.private).toBe(true);
    // Left out, not sent empty: an empty list would read as "no messages".
    expect(result.communication).not.toHaveProperty('inbox');
    expect(result.communication).not.toHaveProperty('outbox');
    if (!result.communication.private) return;
    expect(result.communication.messages).toMatch(/private to beta/);
  });

  it('shows an agent its own mail with receipts, and reading its inbox marks it read', () => {
    const toAlpha = send(repos, 'beta', 'alpha', 'k1');
    const fromAlpha = send(repos, 'alpha', 'beta', 'k2');
    drainInbox(repos, 'alpha', 'claude-code');

    const result = handleInspectWork(repos, { agent_id: 'alpha' }, 'alpha');
    if (result.scope !== 'agent' || result.communication.private) {
      throw new Error('expected own agent scope');
    }
    expect(result.communication.inbox.map((message) => message.receipt.ticks)).toEqual(['read']);
    expect(result.communication.outbox.map((message) => message.receipt.ticks)).toEqual(['✓']);
    expect(repos.agentMessages.get(toAlpha)?.status).toBe('read');
    // The sender looking at its own outbox changes nothing for the recipient.
    expect(repos.agentMessages.get(fromAlpha)?.status).toBe('sent');
  });

  it('hides a thread from an agent that is not part of it', () => {
    const messageId = send(repos, 'beta', 'gamma', 'k1');

    expect(() => handleInspectWork(repos, { message_id: messageId }, 'alpha')).toThrow(
      /does not exist/,
    );
  });

  it('lets the sender check a receipt without marking it read', () => {
    const messageId = send(repos, 'alpha', 'beta', 'k1');
    drainInbox(repos, 'beta', 'claude-code');

    const result = handleInspectWork(repos, { message_id: messageId }, 'alpha');
    if (result.scope !== 'message') throw new Error('expected message scope');
    expect(result.thread[0]?.receipt.ticks).toBe('✓✓');
    expect(repos.agentMessages.get(messageId)?.status).toBe('delivered');
  });

  it('marks a message read, and delivered first, when its recipient inspects it', () => {
    const messageId = send(repos, 'alpha', 'beta', 'k1');

    handleInspectWork(repos, { message_id: messageId }, 'beta');
    const events = repos.agentMessages.listEvents(messageId);
    expect(events.map((event) => `${event.event}:${event.detail ?? ''}`)).toEqual([
      'sent:',
      'delivered:inspect',
      'read:inspect',
    ]);
  });

  it('shows only the parts of a thread the viewer took part in', () => {
    const root = send(repos, 'alpha', 'beta', 'k1');
    drainInbox(repos, 'beta', 'claude-code');
    handleSendAgentMessage(repos, {
      operation: 'reply',
      agentId: 'beta',
      replyToMessageId: root,
      content: 'reply',
      idempotencyKey: 'r1',
    });

    const result = handleInspectWork(repos, { message_id: root }, 'alpha');
    if (result.scope !== 'message') throw new Error('expected message scope');
    expect(result.thread).toHaveLength(2);
    expect(() => handleInspectWork(repos, { message_id: root }, 'gamma')).toThrow(/does not exist/);
  });

  it('shows a caller it cannot identify nothing at all', () => {
    const messageId = send(repos, 'alpha', 'beta', 'k1');

    expect(() => handleInspectWork(repos, { message_id: messageId })).toThrow(/pass your agent_id/);
    expect(repos.agentMessages.get(messageId)?.status).toBe('sent');
  });

  it('trusts an agent naming itself only where the session is invisible', () => {
    const messageId = send(repos, 'alpha', 'beta', 'k1');

    const named = handleInspectWork(repos, { message_id: messageId, agent_id: 'beta' });
    if (named.scope !== 'message') throw new Error('expected message scope');
    expect(named.thread[0]?.content).toBe('alpha to beta');
    // Naming yourself is trusted for reading, never for changing a receipt.
    expect(repos.agentMessages.get(messageId)?.status).toBe('sent');
    const inbox = handleInspectWork(repos, { agent_id: 'beta' });
    if (inbox.scope !== 'agent' || inbox.communication.private) {
      throw new Error('expected own agent scope');
    }
    expect(inbox.communication.inbox).toHaveLength(1);
    expect(repos.agentMessages.get(messageId)?.status).toBe('sent');
    // A visible session always wins over a named one.
    expect(() =>
      handleInspectWork(repos, { message_id: messageId, agent_id: 'beta' }, 'gamma'),
    ).toThrow(/does not exist/);
  });
});
