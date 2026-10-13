import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { buildStatus, renderStatusText } from '../../src/artifacts/work-state-view.js';
import { drainInbox, registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { resolveIdentity, type AgentIdentity } from '../../src/domain/identity.js';
import { createServer } from '../../src/server.js';

async function connect(repos: ReturnType<typeof createRepositories>, identity: AgentIdentity) {
  const server = createServer(repos, { identity });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cline-session-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, string | number | readonly string[]>,
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  return JSON.stringify(result);
}

function present(value: string | number | undefined): string | number {
  if (value === undefined) throw new Error('missing');
  return value;
}

describe('Cline session', () => {
  it('calls every workflow tool and exchanges a queued prompt with another harness', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const cline = resolveIdentity({ CONCORD_AGENT_ID: 'reviewer' }, { kind: 'cline' });
    const claude: AgentIdentity = {
      agentId: 'claude-code:peer0001',
      kind: 'claude-code',
      origin: 'session',
    };
    if (cline === undefined) throw new Error('operator id must resolve');
    registerPullEndpoint(repos, cline.agentId, cline.kind);
    registerPullEndpoint(repos, claude.agentId, claude.kind);
    expect(repos.agentEndpoints.getByAgent(cline.agentId)?.capabilities).toEqual(['pull', 'busy']);

    const mine = await connect(repos, cline);
    const theirs = await connect(repos, claude);
    try {
      await call(mine.client, 'start_work', {
        task_id: 'CLINE-1',
        title: 'Wire Cline',
        kind: 'cline',
      });
      expect(repos.agents.get(cline.agentId)?.kind).toBe('cline');
      expect(renderStatusText(buildStatus(repos))).toContain('· cline');
      await call(mine.client, 'inspect_work', { task_id: 'CLINE-1' });
      await call(mine.client, 'update_work', {
        operation: 'record',
        task_id: 'CLINE-1',
        kind: 'progress',
        content: 'Registered the MCP server',
      });

      const prompted = await call(theirs.client, 'update_work', {
        operation: 'prompt',
        to_agent_id: cline.agentId,
        content: 'Can you hear me?',
        idempotency_key: 'cline-prompt',
      });
      expect(prompted).toContain('"delivery":"queued_pull"');
      expect(prompted).toContain('next turn');
      const messageId = present(drainInbox(repos, cline.agentId, cline.kind)[0]?.messageId);
      await call(mine.client, 'update_work', {
        operation: 'reply',
        reply_to_message_id: String(messageId),
        content: 'Yes, inbox only',
        idempotency_key: 'cline-reply',
      });
      expect(drainInbox(repos, claude.agentId, claude.kind)).toHaveLength(1);

      await call(mine.client, 'finish_work', {
        task_id: 'CLINE-1',
        expected_version: present(repos.tasks.get('CLINE-1')?.version),
        outcome: 'review_ready',
        what_changed: 'Added the Cline adapter',
      });
      await call(mine.client, 'transfer_work', {
        task_id: 'CLINE-1',
        action: 'reopen',
        expected_version: present(repos.tasks.get('CLINE-1')?.version),
        reason: 'Follow up',
      });
      expect(repos.tasks.get('CLINE-1')?.status).toBe('active');
    } finally {
      await theirs.client.close();
      await mine.client.close();
      await theirs.server.close();
      await mine.server.close();
      repos.db.close();
    }
  });
});
