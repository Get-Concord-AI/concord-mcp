import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { agentIdForSession, resolveOpenCodeRequestIdentity } from '../../src/domain/identity.js';
import { createServer } from '../../src/server.js';

describe('OpenCode request identity', () => {
  it('uses V2 request metadata to register the session without exposing its raw ID', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const sessionId = 'ses_private_opencode_session_1';
    const agentId = agentIdForSession('opencode', sessionId);
    const server = createServer(repos, { requestIdentity: resolveOpenCodeRequestIdentity });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'opencode-identity-test', version: '2.2.3' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'OPENCODE-SESSION-1',
          title: 'Test request-scoped identity',
          kind: 'opencode',
        },
        _meta: { 'ai.opencode/sessionID': sessionId },
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ agent_id: agentId });
      expect(repos.agents.get(agentId)?.kind).toBe('opencode');
      expect(JSON.stringify(result)).not.toContain(sessionId);
    } finally {
      await client.close();
      await server.close();
      repos.db.close();
    }
  });

  it('keeps an operator-chosen identity when OpenCode request metadata is present', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const operator = { agentId: 'alpha', kind: 'codex', origin: 'operator' as const };
    const server = createServer(repos, {
      identity: operator,
      requestIdentity: resolveOpenCodeRequestIdentity,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'opencode-operator-identity-test', version: '2.2.3' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'OPENCODE-OPERATOR-1',
          title: 'Keep the chosen identity',
          kind: 'codex',
        },
        _meta: { 'ai.opencode/sessionID': 'ses_private_opencode_session_2' },
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ agent_id: operator.agentId });
      expect(repos.agents.get(operator.agentId)?.kind).toBe(operator.kind);
    } finally {
      await client.close();
      await server.close();
      repos.db.close();
    }
  });

  it('ignores malformed OpenCode metadata at the request boundary', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const server = createServer(repos, { requestIdentity: resolveOpenCodeRequestIdentity });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'opencode-invalid-metadata-test', version: '2.2.3' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'OPENCODE-INVALID-META',
          title: 'Ignore malformed request metadata',
          kind: 'codex',
          agent_id: 'fallback-agent',
        },
        _meta: { 'ai.opencode/sessionID': 23 },
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ agent_id: 'fallback-agent' });
      expect(repos.agents.get('fallback-agent')?.kind).toBe('codex');
    } finally {
      await client.close();
      await server.close();
      repos.db.close();
    }
  });
});
