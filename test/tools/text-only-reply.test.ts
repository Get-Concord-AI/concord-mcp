import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { renderedMessageIds } from '../../src/domain/pull-inbox.js';
import { createServer } from '../../src/server.js';

it('lets a text-only MCP client read a prompt and reply on the original thread', async () => {
  const db = openDatabase(':memory:');
  const repos = createRepositories(db);
  function session(kind: string) {
    const agentId = `${kind}:test`;
    const client = new Client({ name: kind, version: 'test' });
    const server = createServer(repos, { identity: { agentId, kind, origin: 'operator' } });
    return { client, server, agentId, kind };
  }
  const sender = session('codex');
  const reader = session('openhands');
  try {
    for (const { server, client, agentId, kind } of [sender, reader]) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const started = await client.callTool({
        name: 'start_work',
        arguments: { task_id: agentId, title: 'Coordinate parser work', kind },
      });
      expect(started.isError).not.toBe(true);
    }

    const body = `Parser contract check\n${randomUUID()}`;
    const sent = await sender.client.callTool({
      name: 'update_work',
      arguments: {
        operation: 'prompt',
        to_agent_id: reader.agentId,
        content: body,
        idempotency_key: 'prompt',
      },
    });
    expect(sent.isError).not.toBe(true);
    const original = z.object({ message_id: z.string() }).parse(sent.structuredContent);

    const inbox = await reader.client.callTool({
      name: 'inspect_work',
      arguments: { agent_id: reader.agentId },
    });
    expect(inbox.isError).not.toBe(true);
    const text = CallToolResultSchema.shape.content
      .parse(inbox.content)
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    const block = text
      .split(/\n\n(?=\[concord )/u)
      .find((part) => part.startsWith('[concord from '));
    const [replyId] = renderedMessageIds(block ?? '');
    if (block === undefined || replyId === undefined) {
      throw new Error(`Missing reply ID or body in inbox text: ${text}`);
    }
    const receivedBody = block.slice(block.indexOf('\n') + 1);
    expect(receivedBody).toBe(body);
    const reply = await reader.client.callTool({
      name: 'update_work',
      arguments: {
        operation: 'reply',
        reply_to_message_id: replyId,
        content: `ACK ${receivedBody}`,
        idempotency_key: 'reply',
      },
    });
    expect(reply.isError).not.toBe(true);

    const thread = await sender.client.callTool({
      name: 'inspect_work',
      arguments: { message_id: original.message_id },
    });
    expect(thread.structuredContent).toMatchObject({
      thread: [
        { messageId: original.message_id, status: 'replied' },
        {
          replyToMessageId: original.message_id,
          senderAgentId: reader.agentId,
          content: `ACK ${body}`,
        },
      ],
    });
  } finally {
    for (const { client, server } of [sender, reader]) {
      await client.close();
      await server.close();
    }
    db.close();
  }
});
