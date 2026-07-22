import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleGetWorkState, WORK_STATE_URI } from '../../src/tools/get-work-state.js';

describe('handleGetWorkState', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('returns an empty view when nothing is claimed', () => {
    const view = handleGetWorkState(repos);
    expect(view.active).toEqual([]);
    expect(view.overlaps).toEqual([]);
    expect(view.reviewReady).toEqual([]);
    expect(view.openQuestions).toEqual([]);
  });

  it('reports active claims and overlaps recomputed live (no shelling out needed)', () => {
    handleClaimWork(repos, {
      task_id: 'TASK-1',
      title: 'Frontend',
      domains: ['todo'],
      agent: 'codex',
    });
    handleClaimWork(repos, {
      task_id: 'TASK-2',
      title: 'Backend',
      domains: ['todo'],
      agent: 'claude-code',
    });

    const view = handleGetWorkState(repos);
    expect(view.active.map((a) => a.taskId).sort((x, y) => x.localeCompare(y))).toEqual([
      'TASK-1',
      'TASK-2',
    ]);
    // TASK-1's claim returned no overlaps at claim time, but the read surface
    // recomputes them, so the TASK-1 <-> TASK-2 conflict is now visible.
    expect(view.overlaps).toHaveLength(1);
    expect(view.overlaps[0]?.reasons.join('; ')).toContain('todo');
  });
});

describe('work-state MCP surface (end-to-end via in-memory transport)', () => {
  it('exposes get_work_state as a tool and concord://work-state as a resource', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    handleClaimWork(repos, {
      task_id: 'TASK-1',
      title: 'Frontend',
      domains: ['todo'],
      agent: 'codex',
    });

    const server = createServer(repos);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('get_work_state');

      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri)).toContain(WORK_STATE_URI);

      const called = await client.callTool({ name: 'get_work_state' });
      expect(JSON.stringify(called)).toContain('TASK-1');

      const read = await client.readResource({ uri: WORK_STATE_URI });
      expect(JSON.stringify(read)).toContain('TASK-1');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('pushes a resources/updated notification to subscribers when work-state changes', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const server = createServer(repos);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const updated: string[] = [];
      const received = new Promise<void>((resolve) => {
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
          updated.push(notification.params.uri);
          resolve();
        });
      });

      await client.subscribeResource({ uri: WORK_STATE_URI });
      // A write via claim_work should push an update to the subscriber.
      await client.callTool({ name: 'claim_work', arguments: { task_id: 'T1', title: 'X' } });
      await received;

      expect(updated).toContain(WORK_STATE_URI);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
