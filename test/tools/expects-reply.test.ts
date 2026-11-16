import { beforeEach, describe, expect, it } from 'vitest';

import { registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { renderPeerMessage } from '../../src/domain/pull-inbox.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleUpdateWork } from '../../src/tools/workflow.js';

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
  registerPullEndpoint(repos, agentId, 'claude-code');
}

describe('expects_reply', () => {
  let repos: Repositories;
  let promptId: string;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    registerAgent(repos, 'alpha');
    registerAgent(repos, 'beta');
    promptId = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'beta',
      content: 'Ship today?',
      idempotencyKey: 'ask',
    }).message.messageId;
    repos.agentMessages.markDelivered(promptId, 'claude-code', null);
  });

  it('expects an answer to a prompt and none to a reply by default', () => {
    expect(repos.agentMessages.get(promptId)?.expectsReply).toBe(true);
    const reply = handleSendAgentMessage(repos, {
      operation: 'reply',
      agentId: 'beta',
      replyToMessageId: promptId,
      content: 'Yes, shipping now.',
      idempotencyKey: 'answer',
    }).message;
    expect(reply.expectsReply).toBe(false);
  });

  it('lets a reply ask something back', () => {
    const reply = handleSendAgentMessage(repos, {
      operation: 'reply',
      agentId: 'beta',
      replyToMessageId: promptId,
      content: 'EU or US first?',
      expectsReply: true,
      idempotencyKey: 'answer',
    }).message;
    expect(reply.expectsReply).toBe(true);
  });

  it('marks a message that wants no answer in its header', () => {
    const base = { messageId: 'm1', senderAgentId: 'beta', taskId: 'T-1', content: 'Done.' };
    expect(renderPeerMessage({ ...base, expectsReply: false })).toBe(
      '[concord from beta id=m1 task=T-1 no-reply-needed]\nDone.',
    );
    expect(renderPeerMessage({ ...base, expectsReply: true })).toBe(
      '[concord from beta id=m1 task=T-1]\nDone.',
    );
  });

  it('refuses expects_reply on a record', () => {
    const dispatcher = { deliver: () => Promise.reject(new Error('should not deliver')) };
    expect(() =>
      handleUpdateWork(
        repos,
        {
          operation: 'record',
          agent_id: 'alpha',
          task_id: 'T-1',
          kind: 'progress',
          content: 'x',
          expects_reply: false,
        },
        dispatcher,
      ),
    ).toThrow(/only to prompt and reply/u);
  });
});
