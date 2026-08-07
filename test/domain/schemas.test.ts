import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { startWorkInputShape } from '../../src/domain/schemas.js';
import { createServer } from '../../src/server.js';

const startWorkInputSchema = z.object(startWorkInputShape);

describe('start_work input schema', () => {
  it('rejects serialized tool parameters embedded in claim metadata', () => {
    const result = startWorkInputSchema.safeParse({
      task_id: 'DEV-810',
      title: 'Fix edge regeneration',
      kind: 'claude-code',
      summary:
        'Implement the fix.</summary>\n<parameter name="notes">Keep parity.</notes>\n' +
        '<parameter name="expected_files">["src/edge.ts"]',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path.join('.') === 'summary' && issue.message.includes('pass expected_files'),
        ),
      ).toBe(true);
    }
  });

  it('preserves expected_files when metadata is sent in separate fields', () => {
    const result = startWorkInputSchema.parse({
      task_id: 'DEV-810',
      title: 'Fix edge regeneration',
      kind: 'claude-code',
      summary: 'Implement the fix.',
      notes: 'Keep parity.',
      expected_files: ['src/edge.ts', 'test/edge.test.ts'],
    });

    expect(result).toMatchObject({
      summary: 'Implement the fix.',
      notes: 'Keep parity.',
      expected_files: ['src/edge.ts', 'test/edge.test.ts'],
    });
  });

  it('rejects the malformed call atomically at the MCP boundary', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const server = createServer(repos, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'schema-test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'DEV-810',
          title: 'Fix edge regeneration',
          kind: 'claude-code',
          agent_id: 'claude-code:dev-810',
          summary:
            'Implement the fix.</summary>\n' + '<parameter name="expected_files">["src/edge.ts"]',
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('pass expected_files');
      expect(repos.agents.get('claude-code:dev-810')).toBeUndefined();
      expect(repos.tasks.get('DEV-810')).toBeUndefined();

      const retry = await client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'DEV-810',
          title: 'Fix edge regeneration',
          kind: 'claude-code',
          agent_id: 'claude-code:dev-810',
          summary: 'Implement the fix.',
          expected_files: ['src/edge.ts'],
        },
      });

      expect(retry.isError).not.toBe(true);
      expect(repos.tasks.get('DEV-810')?.expectedFiles).toEqual(['src/edge.ts']);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
