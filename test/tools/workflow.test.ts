import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import type { AgentMessageDispatcher } from '../../src/tools/agent-messages.js';
import { PUBLIC_WORKFLOW_TOOLS } from '../../src/tools/workflow.js';

interface Harness {
  client: Client;
  server: ReturnType<typeof createServer>;
}

async function connect(
  repos: Repositories,
  messageDispatcher?: AgentMessageDispatcher,
): Promise<Harness> {
  const server = createServer(repos, messageDispatcher === undefined ? {} : { messageDispatcher });
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

  it('steers a busy agent immediately and exposes the durable message thread', async () => {
    const deliveries: Parameters<AgentMessageDispatcher['deliver']>[0][] = [];
    const harness = await connect(repos, {
      deliver(request) {
        deliveries.push(request);
        return Promise.resolve({ provider: 'codex', receipt: 'turn-42' });
      },
    });
    try {
      for (const [taskId, agentId] of [
        ['TASK-SENDER', 'codex:sender'],
        ['TASK-TARGET', 'codex:target'],
      ]) {
        await harness.client.callTool({
          name: 'start_work',
          arguments: { task_id: taskId, title: taskId, kind: 'codex', agent_id: agentId },
        });
      }
      repos.agentEndpoints.upsert({
        endpointId: 'endpoint-target',
        agentId: 'codex:target',
        provider: 'codex',
        transport: 'local-socket',
        capabilities: ['steer', 'start-turn', 'active-turn'],
        address: '/tmp/concord-target.sock',
        credentialHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const sent = await harness.client.callTool({
        name: 'update_work',
        arguments: {
          operation: 'prompt',
          task_id: 'TASK-TARGET',
          agent_id: 'codex:sender',
          to_agent_id: 'codex:target',
          content: 'Please re-check the parser boundary.',
          idempotency_key: 'sender-1',
        },
      });

      expect(sent.isError).not.toBe(true);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        senderAgentId: 'codex:sender',
        recipientAgentId: 'codex:target',
        activeTurn: true,
      });
      expect(deliveries[0]?.content).toContain('Please re-check the parser boundary.');
      const message = repos.agentMessages.listByTask('TASK-TARGET')[0];
      expect(message).toMatchObject({ status: 'delivered', providerReceipt: 'turn-42' });

      const inspected = await harness.client.callTool({
        name: 'inspect_work',
        arguments: { message_id: message?.messageId },
      });
      expect(inspected.isError).not.toBe(true);
      expect(JSON.stringify(inspected)).toContain('accepted');
      expect(JSON.stringify(inspected)).toContain('delivered');
    } finally {
      await close(harness);
    }
  });

  it('records an explicit reply and does not redeliver an idempotent replay', async () => {
    let deliveryCount = 0;
    const harness = await connect(repos, {
      deliver(request) {
        deliveryCount += 1;
        return Promise.resolve({ provider: request.endpoint.provider });
      },
    });
    try {
      for (const agentId of ['codex:a', 'claude:b']) {
        repos.agents.upsert({
          agentId,
          kind: agentId.split(':')[0] ?? 'agent',
          owner: null,
          model: null,
          pid: null,
          cwd: null,
          worktree: null,
          branch: null,
          summary: null,
          status: 'active',
        });
        repos.agentEndpoints.upsert({
          endpointId: `endpoint-${agentId}`,
          agentId,
          provider: agentId.split(':')[0] ?? 'agent',
          transport: 'local-socket',
          capabilities: ['steer', 'start-turn'],
          address: `/tmp/${agentId}.sock`,
          credentialHash: 'hash',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }

      const promptArguments = {
        operation: 'prompt',
        agent_id: 'codex:a',
        to_agent_id: 'claude:b',
        content: 'What did you find?',
        idempotency_key: 'question-1',
      } as const;
      await harness.client.callTool({ name: 'update_work', arguments: promptArguments });
      await harness.client.callTool({ name: 'update_work', arguments: promptArguments });
      expect(deliveryCount).toBe(1);

      const parent = repos.agentMessages.listByAgent('codex:a')[0];
      const reply = await harness.client.callTool({
        name: 'update_work',
        arguments: {
          operation: 'reply',
          agent_id: 'claude:b',
          reply_to_message_id: parent?.messageId,
          content: 'The boundary is safe.',
          idempotency_key: 'answer-1',
        },
      });
      expect(reply.isError).not.toBe(true);
      expect(repos.agentMessages.get(parent?.messageId ?? '')?.status).toBe('replied');
      expect(repos.agentMessages.listThread(parent?.messageId ?? '')).toHaveLength(2);
    } finally {
      await close(harness);
    }
  });

  it('fails immediately for an unreachable target without suggesting another agent', async () => {
    repos.agents.upsert({
      agentId: 'codex:sender',
      kind: 'codex',
      owner: null,
      model: null,
      pid: null,
      cwd: null,
      worktree: null,
      branch: null,
      summary: null,
      status: 'active',
    });
    repos.agents.upsert({
      agentId: 'cursor:offline',
      kind: 'cursor',
      owner: null,
      model: null,
      pid: null,
      cwd: null,
      worktree: null,
      branch: null,
      summary: null,
      status: 'active',
    });
    const harness = await connect(repos);
    try {
      const result = await harness.client.callTool({
        name: 'update_work',
        arguments: {
          operation: 'prompt',
          agent_id: 'codex:sender',
          to_agent_id: 'cursor:offline',
          content: 'Are you there?',
          idempotency_key: 'offline-1',
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('target_not_promptable');
      expect(JSON.stringify(result)).not.toContain('candidate');
      expect(repos.agentMessages.listByAgent('cursor:offline')[0]?.status).toBe('failed');
    } finally {
      await close(harness);
    }
  });

  it('retries a durable pending message after an interrupted delivery attempt', async () => {
    for (const agentId of ['codex:sender', 'codex:target']) {
      repos.agents.upsert({
        agentId,
        kind: 'codex',
        owner: null,
        model: null,
        pid: null,
        cwd: null,
        worktree: null,
        branch: null,
        summary: null,
        status: 'active',
      });
    }
    repos.agentEndpoints.upsert({
      endpointId: 'endpoint-target',
      agentId: 'codex:target',
      provider: 'codex',
      transport: 'local-socket',
      capabilities: ['steer'],
      address: '/tmp/target.sock',
      credentialHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const pending = repos.agentMessages.create({
      messageId: 'pending-message',
      taskId: null,
      senderAgentId: 'codex:sender',
      recipientAgentId: 'codex:target',
      replyToMessageId: null,
      content: 'Retry me',
      idempotencyKey: 'pending-1',
    });
    let deliveries = 0;
    const harness = await connect(repos, {
      deliver() {
        deliveries += 1;
        return Promise.resolve({ provider: 'codex' });
      },
    });
    try {
      const result = await harness.client.callTool({
        name: 'update_work',
        arguments: {
          operation: 'prompt',
          agent_id: 'codex:sender',
          to_agent_id: 'codex:target',
          content: 'Retry me',
          idempotency_key: 'pending-1',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(deliveries).toBe(1);
      expect(repos.agentMessages.get(pending.messageId)?.status).toBe('delivered');
      expect(JSON.stringify(result)).toContain('"idempotent_replay":true');
    } finally {
      await close(harness);
    }
  });
});
