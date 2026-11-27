import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { drainInbox } from '../../src/cli/commands/inbox.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { renderedMessageIds } from '../../src/domain/pull-inbox.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { inspectWorkResponse } from '../../src/tools/inspect-work-response.js';
import { handleInspectWork } from '../../src/tools/inspect-work.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

describe('inspect_work text for clients that only display content', () => {
  let repos: Repositories;
  const body = 'Check the parser contract.\nDoes it accept an empty string?';
  const privateBody = 'A separate conversation on the same task.';

  function send(toAgentId: string, content: string) {
    return handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'sender',
      toAgentId,
      taskId: 'parser',
      content,
      idempotencyKey: content,
    }).message.messageId;
  }

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    for (const id of ['sender', 'reader', 'other']) {
      handleRegisterAgent(repos, { agent_id: id, kind: 'codex' });
    }
    handleClaimWork(repos, { task_id: 'parser', title: 'Fix parser', agent_id: 'sender' });
  });

  afterEach(() => {
    vi.useRealTimers();
    repos.db.close();
  });

  it.each(['inbox', 'thread', 'task'] as const)(
    'returns the full message and reply ID in %s text',
    (scope) => {
      const messageId = send('reader', body);
      const otherId = send('other', privateBody);
      const scopes = {
        inbox: { agent_id: 'reader' },
        thread: { message_id: messageId },
        task: { task_id: 'parser' },
      };
      const result = handleInspectWork(repos, scopes[scope], 'reader');
      const response = inspectWorkResponse(result, undefined);
      const text = response.content.map((block) => block.text).join('\n');

      expect(text).toContain(`[concord from sender id=${messageId} task=parser]\n${body}`);
      expect(text).not.toContain(privateBody);
      expect(JSON.stringify(response.structuredContent)).not.toContain(privateBody);
      expect(repos.agentMessages.get(messageId)?.status).toBe('read');
      expect(repos.agentMessages.get(otherId)?.status).toBe('sent');
    },
  );

  it.each([
    ['thread', 'replied'],
    ['thread', 'failed'],
    ['task', 'replied'],
    ['task', 'failed'],
  ] as const)('labels incoming %s history when the message is %s', (scope, status) => {
    const id = send('reader', body);
    if (status === 'replied') {
      repos.agentMessages.markReplied(id);
    } else {
      repos.agentMessages.markFailed(id, 'expired', null);
    }
    const selector = scope === 'thread' ? { message_id: id } : { task_id: 'parser' };
    const response = inspectWorkResponse(handleInspectWork(repos, selector, 'reader'), undefined);

    expect(response.content[0]?.text).toContain(
      `[concord from sender id=${id} task=parser ${status} no-reply-needed]\n${body}`,
    );
    expect(repos.agentMessages.get(id)?.status).toBe(status);
  });

  it('shows only the newest ten live inbox messages and marks only those read', () => {
    vi.useFakeTimers({ now: new Date('2026-04-01T00:00:00Z') });
    const backlog = Array.from({ length: 12 }, (_, index) => {
      vi.advanceTimersByTime(1);
      return send('reader', `prompt ${String(index)}`);
    });
    vi.advanceTimersByTime(1);
    const replied = send('reader', 'Already answered.');
    repos.agentMessages.markReplied(replied);
    const failed = send('reader', 'Expired prompt.');
    repos.agentMessages.markFailed(failed, 'expired', null);

    const response = inspectWorkResponse(
      handleInspectWork(repos, { agent_id: 'reader' }, 'reader'),
      undefined,
    );
    const text = response.content.map((block) => block.text).join('\n');
    const shown = backlog.slice(2);
    expect(renderedMessageIds(text)).toEqual(shown);
    expect(backlog.filter((id) => repos.agentMessages.get(id)?.status === 'read')).toEqual(shown);
    expect(repos.agentMessages.get(replied)?.status).toBe('replied');
    expect(repos.agentMessages.get(failed)?.status).toBe('failed');
    const history = response.structuredContent;
    if (!('inbox' in history)) throw new Error('Expected the recipient inbox');
    expect(new Set(history.inbox.map((message) => message.messageId))).toEqual(
      new Set([...backlog, replied, failed]),
    );

    const next = inspectWorkResponse(
      handleInspectWork(repos, { agent_id: 'reader' }, 'reader'),
      undefined,
    );
    const nextIds = renderedMessageIds(next.content.map((block) => block.text).join('\n'));
    expect(nextIds).toEqual(backlog.slice(0, 2));
    expect(backlog.every((id) => repos.agentMessages.get(id)?.status === 'read')).toBe(true);
  });

  it('drops an expiring preview without marking an older message in its place', () => {
    const now = Date.parse('2026-04-01T00:00:00Z');
    vi.useFakeTimers({ now });
    const oldest = send('reader', 'Outside the preview.');
    vi.advanceTimersByTime(1);
    const expiring = send('reader', 'About to expire.');
    for (let i = 0; i < 9; i++) send('reader', `later ${String(i)}`);
    repos.db
      .prepare('UPDATE agent_messages SET expires_at = ? WHERE message_id = ?')
      .run(new Date(now + 2).toISOString(), expiring);
    const markRead = repos.agentMessages.markReadByInspect.bind(repos.agentMessages);
    vi.spyOn(repos.agentMessages, 'markReadByInspect').mockImplementation((...args) => {
      vi.setSystemTime(now + 3);
      return markRead(...args);
    });

    const response = inspectWorkResponse(
      handleInspectWork(repos, { agent_id: 'reader' }, 'reader'),
      undefined,
    );
    const shown = renderedMessageIds(response.content[0]?.text ?? '');
    expect(repos.agentMessages.get(expiring)?.status).toBe('failed');
    expect(repos.agentMessages.get(oldest)?.status).toBe('sent');
    expect(shown).toHaveLength(9);
    expect(shown).not.toContain(expiring);
    expect(shown).not.toContain(oldest);
    const history = response.structuredContent;
    if (!('inbox' in history)) throw new Error('Expected the recipient inbox');
    expect(history.inbox.find((message) => message.messageId === expiring)?.status).toBe('failed');
    expect(
      history.inbox
        .filter((message) => message.status === 'read')
        .map((message) => message.messageId),
    ).toEqual(shown);
  });

  it.each(['thread', 'task'] as const)(
    'renders outgoing receipts and incoming replies in %s text',
    (scope) => {
      const id = send('reader', body);
      const selector = scope === 'thread' ? { message_id: id } : { task_id: 'parser' };
      const text = () =>
        inspectWorkResponse(handleInspectWork(repos, selector, 'sender'), undefined)
          .content.map((block) => block.text)
          .join('\n');

      expect(text()).toContain(`[concord to reader id=${id} ✓]`);
      drainInbox(repos, 'reader', 'claude-code');
      expect(text()).toContain(`[concord to reader id=${id} ✓✓]`);
      handleInspectWork(repos, { message_id: id }, 'reader');
      expect(text()).toContain(`[concord to reader id=${id} read]`);
      const reply = handleSendAgentMessage(repos, {
        operation: 'reply',
        agentId: 'reader',
        replyToMessageId: id,
        content: 'Answer from reader.',
        idempotencyKey: 'answer',
      }).message;
      const afterReply = text();
      expect(afterReply).toContain(`[concord to reader id=${id} replied]`);
      expect(renderedMessageIds(afterReply)).toEqual([reply.messageId]);
      expect(afterReply).toContain(reply.content);
    },
  );

  it('only renders presence when another session inspects the recipient inbox', () => {
    const id = send('reader', body);
    const result = handleInspectWork(repos, { agent_id: 'reader' }, 'other');
    const response = inspectWorkResponse(result, undefined);
    expect(response.content[0]?.text).toContain('private to reader');
    expect(response.content[0]?.text).not.toContain(body);
    expect(response.structuredContent).not.toHaveProperty('inbox');
    expect(repos.agentMessages.get(id)?.status).toBe('sent');
  });
});
