import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
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

      expect(text).toContain(body);
      expect(text).toContain(messageId);
      expect(text).not.toContain(privateBody);
      expect(JSON.stringify(response.structuredContent)).not.toContain(privateBody);
      expect(repos.agentMessages.get(messageId)?.status).toBe('read');
      expect(repos.agentMessages.get(otherId)?.status).toBe('sent');
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
