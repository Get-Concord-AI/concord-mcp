import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import { inspectWorkResponse } from '../../src/tools/inspect-work-response.js';
import { handleInspectWork } from '../../src/tools/inspect-work.js';

let directory: string;
let reader: Repositories;
let sender: Repositories;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'concord-inbox-'));
  const path = join(directory, 'concord.db');
  reader = createRepositories(openDatabase(path));
  sender = createRepositories(openDatabase(path));
  reader.db.pragma('busy_timeout = 0');
  for (const agentId of ['sender', 'reader']) sender.agents.upsert({ agentId, kind: 'test' });
});

afterEach(() => {
  reader.db.close();
  sender.db.close();
  rmSync(directory, { recursive: true, force: true });
});

function send(index: number) {
  const id = `msg-${String(index).padStart(2, '0')}`;
  return sender.agentMessages.create({
    messageId: id,
    taskId: null,
    senderAgentId: 'sender',
    recipientAgentId: 'reader',
    replyToMessageId: null,
    content: `Payload for ${id}.`,
    expectsReply: index === 0,
    idempotencyKey: id,
  });
}

it('pages a self-named MCP reader through older unread messages using only returned text', async () => {
  const oldest = send(0);
  const recent = Array.from({ length: 10 }, (_, index) => send(index + 1));
  const server = createServer(reader);
  const client = new Client({ name: 'text-only', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    async function inspect(args: Record<string, unknown>) {
      const result = await client.callTool({ name: 'inspect_work', arguments: args });
      expect(result.isError).not.toBe(true);
      return CallToolResultSchema.shape.content
        .parse(result.content)
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
    }
    const first = await inspect({ agent_id: 'reader' });
    expect(first.match(/^\[concord from /gmu)).toHaveLength(10);
    for (const message of recent) {
      expect(first).toContain(`id=${message.messageId} no-reply-needed]\n${message.content}`);
    }
    expect(first).not.toContain(oldest.content);
    const nextArgs = /^Next page: inspect_work (\{.*\})$/mu.exec(first)?.[1];
    if (nextArgs === undefined) throw new Error('Missing next-page arguments in inbox text');
    const newcomer = send(11);
    const second = await inspect(z.record(z.string(), z.unknown()).parse(JSON.parse(nextArgs)));
    expect(second).toContain(`id=${oldest.messageId}]\n${oldest.content}`);
    expect(second.match(/^\[concord from /gmu)).toHaveLength(1);
    expect(second).toContain('End of inbox page sequence.');
    for (const message of [oldest, ...recent, newcomer]) {
      expect(
        sender.agentMessages.listEvents(message.messageId).map((event) => event.event),
      ).toEqual(['sent']);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

it('records each verified cursor-free page against exactly the IDs shown on that call', () => {
  const backlog = Array.from({ length: 12 }, (_, index) => send(index).messageId);
  const previouslyRead = new Set<string>();
  for (const expectedPage of [backlog.slice(2), backlog.slice(0, 2)]) {
    const result = handleInspectWork(reader, { agent_id: 'reader' }, 'reader');
    const response = inspectWorkResponse(result, undefined);
    const text = response.content.map((block) => block.text).join('\n');
    const shown = [...text.matchAll(/^\[concord from sender id=(\S+?)[\s\]]/gmu)].map((m) => m[1]);
    const read = sender.agentMessages
      .listByAgent('reader')
      .filter((message) => message.status === 'read');
    const newReads = read.map((m) => m.messageId).filter((id) => !previouslyRead.has(id));
    expect(shown).toEqual(expectedPage);
    expect(newReads).toEqual(shown);
    for (const id of newReads) previouslyRead.add(id);
    expect(response.structuredContent).toMatchObject({
      inbox: backlog.map((messageId) => ({ messageId })),
    });
  }
});

it('prioritizes unread messages and keeps paging when the previous boundary is answered', () => {
  const oldRead = send(0);
  const oldestUnread = send(1);
  const boundary = send(2);
  const newest = Array.from({ length: 9 }, (_, index) => send(index + 3).messageId);
  sender.agentMessages.markReadByInspect('reader', [oldRead.messageId, send(12).messageId]);
  const first = handleInspectWork(reader, { agent_id: 'reader' });
  if (first.scope !== 'agent' || first.nextInboxBefore === null)
    throw new Error('Expected a next page');
  expect(first.textInbox.map((m) => m.messageId)).toEqual([boundary.messageId, ...newest]);
  sender.agentMessages.markReplied(boundary.messageId);
  const next = handleInspectWork(reader, {
    agent_id: 'reader',
    inbox_before: first.nextInboxBefore,
  });
  expect(next).toMatchObject({
    textInbox: [{ messageId: oldestUnread.messageId }],
    nextInboxBefore: null,
  });
});

it('lets presence and receipt-free inbox reads finish while another connection holds the write lock', () => {
  const message = send(0);
  sender.db
    .transaction(() => {
      const hidden = handleInspectWork(reader, { agent_id: 'reader' }, 'sender');
      expect(hidden).toMatchObject({ communication: { private: true }, textInbox: [] });
      const selfNamed = handleInspectWork(reader, { agent_id: 'reader' });
      expect(selfNamed).toMatchObject({ textInbox: [{ messageId: message.messageId }] });
      expect(sender.agentMessages.get(message.messageId)?.status).toBe('sent');
    })
    .immediate();

  handleInspectWork(reader, { agent_id: 'reader' }, 'reader');
  sender.db
    .transaction(() => {
      const own = handleInspectWork(reader, { agent_id: 'reader' }, 'reader');
      expect(own).toMatchObject({ textInbox: [{ messageId: message.messageId, status: 'read' }] });
    })
    .immediate();
});
