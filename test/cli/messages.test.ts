import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { drainInbox, registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { listMessages, renderMessageLines } from '../../src/cli/commands/messages.js';
import { openContext } from '../../src/cli/context.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { ensureAgentRegistered } from '../../src/tools/register-agent.js';

describe('concord messages', () => {
  it('shows every message with its receipt, and never changes one', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'concord-messages-'));
    const { repos } = openContext(repo);
    ensureAgentRegistered(repos, { agentId: 'alpha', kind: 'claude-code' }, repo);
    registerPullEndpoint(repos, 'beta', 'claude-code');
    const sent = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'beta',
      content: 'please review',
      idempotencyKey: 'k1',
    }).message.messageId;
    drainInbox(repos, 'beta', 'claude-code');

    const lines = renderMessageLines(await listMessages(repo)).join('\n');
    expect(lines).toContain('alpha → beta');
    expect(lines).toContain('✓✓ delivered');
    expect(lines).toContain('please review');
    expect(await listMessages(repo, { agent: 'gamma' })).toEqual([]);
    expect(await listMessages(repo, { thread: sent })).toHaveLength(1);
    expect(repos.agentMessages.get(sent)?.status).toBe('delivered');
  });
});
