import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';

import { drainInbox, registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import { effectiveEndpointCapabilities } from '../../src/domain/delivery.js';

it('queues a DeepSeek/Codex prompt until the recipient reads its inbox and replies', async () => {
  const db = openDatabase(':memory:');
  const repos = createRepositories(db);
  const sessions = [
    { agentId: 'deepseek:test', kind: 'deepseek', origin: 'operator' as const },
    { agentId: 'codex:test', kind: 'codex', origin: 'operator' as const },
  ].map((identity) => ({
    identity,
    server: createServer(repos, { identity }),
    client: new Client({ name: identity.kind, version: 'test' }),
  }));
  try {
    for (const { identity, server, client } of sessions) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const started = await client.callTool({
        name: 'start_work',
        arguments: {
          task_id: `${identity.kind}-task`,
          title: `${identity.kind} task`,
          kind: identity.kind,
        },
      });
      expect(started.isError).not.toBe(true);
      registerPullEndpoint(repos, identity.agentId, identity.kind);
    }
    const deepseek = sessions.find((session) => session.identity.kind === 'deepseek');
    const codex = sessions.find((session) => session.identity.kind === 'codex');
    if (deepseek === undefined || codex === undefined) throw new Error('Missing test session');
    expect(repos.agents.get('deepseek:test')?.kind).toBe('deepseek');
    const endpoint = repos.agentEndpoints.getByAgent('deepseek:test');
    if (endpoint === undefined) throw new Error('Missing DeepSeek endpoint');
    expect(effectiveEndpointCapabilities(endpoint)).toContain('busy');
    expect(effectiveEndpointCapabilities(endpoint)).not.toContain('idle');
    const prompt = await codex.client.callTool({
      name: 'update_work',
      arguments: {
        operation: 'prompt',
        to_agent_id: 'deepseek:test',
        content: 'Check the configuration.',
        idempotency_key: 'codex-prompt',
      },
    });
    expect(prompt.isError).not.toBe(true);
    const queued = repos.agentMessages.listByAgent('deepseek:test');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe('sent');
    await deepseek.client.callTool({
      name: 'inspect_work',
      arguments: { agent_id: 'deepseek:test' },
    });
    expect(repos.agentMessages.get(queued[0]?.messageId ?? '')?.status).toBe('read');
    const reply = await deepseek.client.callTool({
      name: 'update_work',
      arguments: {
        operation: 'reply',
        reply_to_message_id: queued[0]?.messageId,
        content: 'Configuration checked.',
        idempotency_key: 'deepseek-reply',
      },
    });
    expect(reply.isError).not.toBe(true);
    expect(drainInbox(repos, 'codex:test', 'codex')[0]?.content).toContain(
      'Configuration checked.',
    );
    expect(repos.agentMessages.get(queued[0]?.messageId ?? '')?.status).toBe('replied');
  } finally {
    for (const { client, server } of sessions) {
      await client.close();
      await server.close();
    }
    db.close();
  }
});
