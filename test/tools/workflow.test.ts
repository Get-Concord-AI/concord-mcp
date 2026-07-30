import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import { PUBLIC_WORKFLOW_TOOLS } from '../../src/tools/workflow.js';

interface Harness {
  client: Client;
  server: ReturnType<typeof createServer>;
}

async function connect(repos: Repositories): Promise<Harness> {
  const server = createServer(repos);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'workflow-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function close(harness: Harness): Promise<void> {
  await harness.client.close();
  await harness.server.close();
}

describe('simplified workflow MCP contract', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('exposes exactly five workflow tools and no legacy aliases', async () => {
    const harness = await connect(repos);
    try {
      const listed = await harness.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...PUBLIC_WORKFLOW_TOOLS]);
    } finally {
      await close(harness);
    }
  });

  it('runs start, inspect, update, review, reopen, and complete through the new surface', async () => {
    const harness = await connect(repos);
    try {
      const started = await harness.client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'TASK-1',
          title: 'Simplify lifecycle',
          kind: 'codex',
          agent_id: 'codex:owner',
          owner: 'alex',
          expected_files: ['src/server.ts'],
        },
      });
      expect(started.isError).not.toBe(true);
      expect(repos.tasks.get('TASK-1')).toMatchObject({
        status: 'active',
        agentId: 'codex:owner',
        expectedFiles: ['src/server.ts'],
      });

      await harness.client.callTool({
        name: 'update_work',
        arguments: {
          task_id: 'TASK-1',
          agent_id: 'codex:owner',
          kind: 'decision',
          content: 'Expose five tools',
        },
      });
      const inspected = await harness.client.callTool({
        name: 'inspect_work',
        arguments: { task_id: 'TASK-1' },
      });
      expect(JSON.stringify(inspected)).toContain('Expose five tools');

      const reviewed = await harness.client.callTool({
        name: 'finish_work',
        arguments: {
          task_id: 'TASK-1',
          agent_id: 'codex:owner',
          expected_version: 1,
          outcome: 'review_ready',
          what_changed: 'Consolidated the lifecycle',
          tests_run: ['pnpm test'],
        },
      });
      expect(reviewed.isError).not.toBe(true);
      expect(repos.tasks.get('TASK-1')?.status).toBe('review_ready');
      expect(repos.reviews.latestForTask('TASK-1')?.planSummary).toBe('Consolidated the lifecycle');

      await harness.client.callTool({
        name: 'transfer_work',
        arguments: {
          task_id: 'TASK-1',
          action: 'reopen',
          agent_id: 'codex:owner',
          expected_version: 2,
          reason: 'Apply final fixes',
        },
      });
      const completed = await harness.client.callTool({
        name: 'finish_work',
        arguments: {
          task_id: 'TASK-1',
          agent_id: 'codex:owner',
          expected_version: 3,
          outcome: 'complete',
          what_changed: 'Applied final fixes',
        },
      });
      expect(completed.isError).not.toBe(true);
      expect(repos.tasks.get('TASK-1')?.status).toBe('complete');
      expect(repos.handoffs.latestForTask('TASK-1')?.whatChanged).toBe('Applied final fixes');
    } finally {
      await close(harness);
    }
  });

  it('uses transfer_work for handoff, release, assignment, and acceptance', async () => {
    const harness = await connect(repos);
    try {
      for (const [taskId, agentId] of [
        ['TASK-A', 'codex:a'],
        ['TASK-B', 'codex:b'],
      ]) {
        await harness.client.callTool({
          name: 'start_work',
          arguments: {
            task_id: taskId,
            title: taskId,
            kind: 'codex',
            agent_id: agentId,
          },
        });
      }

      const offered = await harness.client.callTool({
        name: 'transfer_work',
        arguments: {
          task_id: 'TASK-A',
          action: 'offer',
          agent_id: 'codex:a',
          expected_version: 1,
          to_agent_id: 'codex:b',
          what_changed: 'Parser is ready',
        },
      });
      expect(offered.isError).not.toBe(true);
      expect(repos.tasks.get('TASK-A')).toMatchObject({
        status: 'handoff_offered',
        agentId: 'codex:a',
        assignedAgentId: 'codex:b',
      });

      const acceptedHandoff = await harness.client.callTool({
        name: 'transfer_work',
        arguments: {
          task_id: 'TASK-A',
          action: 'accept',
          agent_id: 'codex:b',
          expected_version: 2,
        },
      });
      expect(acceptedHandoff.isError).not.toBe(true);
      expect(repos.tasks.get('TASK-A')).toMatchObject({
        status: 'active',
        agentId: 'codex:b',
      });

      await harness.client.callTool({
        name: 'transfer_work',
        arguments: {
          task_id: 'TASK-A',
          action: 'release',
          agent_id: 'codex:b',
          expected_version: 3,
          reason: 'Return to queue',
        },
      });
      await harness.client.callTool({
        name: 'transfer_work',
        arguments: {
          task_id: 'TASK-A',
          action: 'assign',
          agent_id: 'codex:b',
          expected_version: 4,
          to_agent_id: 'codex:a',
        },
      });
      await harness.client.callTool({
        name: 'transfer_work',
        arguments: {
          task_id: 'TASK-A',
          action: 'accept',
          agent_id: 'codex:a',
          expected_version: 5,
        },
      });
      expect(repos.tasks.get('TASK-A')).toMatchObject({
        status: 'active',
        agentId: 'codex:a',
        version: 6,
      });
    } finally {
      await close(harness);
    }
  });

  it('accepts addressed assignments through start_work', async () => {
    const harness = await connect(repos);
    try {
      for (const [taskId, agentId] of [
        ['TASK-OWNER', 'codex:owner'],
        ['TASK-ASSIGNEE', 'codex:assignee'],
      ]) {
        await harness.client.callTool({
          name: 'start_work',
          arguments: { task_id: taskId, title: taskId, kind: 'codex', agent_id: agentId },
        });
      }
      await harness.client.callTool({
        name: 'transfer_work',
        arguments: {
          task_id: 'TASK-OWNER',
          action: 'assign',
          agent_id: 'codex:owner',
          expected_version: 1,
          to_agent_id: 'codex:assignee',
        },
      });

      const resumed = await harness.client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'TASK-OWNER',
          title: 'TASK-OWNER',
          kind: 'codex',
          agent_id: 'codex:assignee',
        },
      });

      expect(resumed.isError).not.toBe(true);
      expect(JSON.stringify(resumed)).toContain('"resumed_by":"assignment"');
      expect(repos.tasks.get('TASK-OWNER')).toMatchObject({
        status: 'active',
        agentId: 'codex:assignee',
        version: 3,
      });
    } finally {
      await close(harness);
    }
  });

  it('rolls back registration when start_work cannot take an owned task', async () => {
    const harness = await connect(repos);
    try {
      await harness.client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'TASK-OWNED',
          title: 'Owned work',
          kind: 'codex',
          agent_id: 'codex:owner',
        },
      });

      const rejected = await harness.client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'TASK-OWNED',
          title: 'Owned work',
          kind: 'claude-code',
          agent_id: 'claude:intruder',
        },
      });

      expect(rejected.isError).toBe(true);
      expect(repos.agents.get('claude:intruder')).toBeUndefined();
      expect(repos.tasks.get('TASK-OWNED')?.agentId).toBe('codex:owner');
    } finally {
      await close(harness);
    }
  });

  it('rejects decline when there is no assignment or handoff', async () => {
    const harness = await connect(repos);
    try {
      await harness.client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'TASK-ACTIVE',
          title: 'Active work',
          kind: 'codex',
          agent_id: 'codex:owner',
        },
      });

      const rejected = await harness.client.callTool({
        name: 'transfer_work',
        arguments: {
          task_id: 'TASK-ACTIVE',
          action: 'decline',
          agent_id: 'codex:owner',
          expected_version: 1,
          reason: 'Nothing to decline',
        },
      });

      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toContain('no assignment or handoff to decline');
    } finally {
      await close(harness);
    }
  });

  it('keeps finish_work atomic when the caller supplies a stale version', async () => {
    const harness = await connect(repos);
    try {
      await harness.client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'TASK-STALE',
          title: 'Stale finish',
          kind: 'codex',
          agent_id: 'codex:owner',
        },
      });
      const result = await harness.client.callTool({
        name: 'finish_work',
        arguments: {
          task_id: 'TASK-STALE',
          agent_id: 'codex:owner',
          expected_version: 99,
          outcome: 'complete',
          what_changed: 'Should not persist',
        },
      });
      expect(result.isError).toBe(true);
      expect(repos.handoffs.latestForTask('TASK-STALE')).toBeUndefined();
      expect(repos.tasks.get('TASK-STALE')?.status).toBe('active');
    } finally {
      await close(harness);
    }
  });
});
