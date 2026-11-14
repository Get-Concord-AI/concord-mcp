import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import type { AgentIdentity } from '../../src/domain/identity.js';

interface Harness {
  client: Client;
  server: ReturnType<typeof createServer>;
}

async function connect(repos: Repositories, identity?: AgentIdentity): Promise<Harness> {
  const server = createServer(repos, {
    ...(identity === undefined ? {} : { identity }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'live-session-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function close(harness: Harness): Promise<void> {
  await harness.client.close();
  await harness.server.close();
}

const ENV_IDENTITY: AgentIdentity = {
  agentId: 'claude-code:bbbb2222',
  kind: 'claude-code',
  origin: 'session',
};

const RESUMED: AgentIdentity = {
  agentId: 'claude-code:aaaa1111',
  kind: 'claude-code',
  origin: 'hook',
};

function startWork(client: Client, taskId: string) {
  return client.callTool({
    name: 'start_work',
    arguments: { task_id: taskId, title: taskId, kind: 'claude-code' },
  });
}

describe('live session binding (issue #358)', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('acts as the session the hook recorded, not the one the env was spawned with', async () => {
    repos.agents.upsert({ agentId: RESUMED.agentId, kind: 'claude-code' });
    repos.sessionBindings.upsert(process.ppid, RESUMED.agentId, 'claude-code');
    const harness = await connect(repos, ENV_IDENTITY);
    try {
      const result = await startWork(harness.client, 'T-RESUME');
      expect(result.structuredContent).toMatchObject({
        task_id: 'T-RESUME',
        identity_drift: {
          env_agent_id: ENV_IDENTITY.agentId,
          live_agent_id: RESUMED.agentId,
        },
      });
      expect(repos.tasks.get('T-RESUME')?.agentId).toBe(RESUMED.agentId);
      // Acting as the env identity would have registered it as a new agent.
      expect(repos.agents.get(ENV_IDENTITY.agentId)).toBeUndefined();
    } finally {
      await close(harness);
    }
  });

  it('surfaces the drift advisory once, not on every call', async () => {
    repos.agents.upsert({ agentId: RESUMED.agentId, kind: 'claude-code' });
    repos.sessionBindings.upsert(process.ppid, RESUMED.agentId, 'claude-code');
    const harness = await connect(repos, ENV_IDENTITY);
    try {
      const first = await harness.client.callTool({ name: 'inspect_work', arguments: {} });
      expect(JSON.stringify(first)).toContain('identity_drift');
      const second = await harness.client.callTool({ name: 'inspect_work', arguments: {} });
      expect(JSON.stringify(second)).not.toContain('identity_drift');
    } finally {
      await close(harness);
    }
  });

  it('ignores a binding whose agent has gone away, keeping the env identity', async () => {
    repos.agents.upsert(
      { agentId: RESUMED.agentId, kind: 'claude-code' },
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    );
    repos.sessionBindings.upsert(process.ppid, RESUMED.agentId, 'claude-code');
    const harness = await connect(repos, ENV_IDENTITY);
    try {
      const result = await startWork(harness.client, 'T-STALE');
      expect(JSON.stringify(result)).not.toContain('identity_drift');
      expect(repos.tasks.get('T-STALE')?.agentId).toBe(ENV_IDENTITY.agentId);
    } finally {
      await close(harness);
    }
  });

  it('ignores a binding of another kind on the same client pid', async () => {
    // Grok launched inside a Claude session's shell: the Claude hook bound this
    // client pid, but Grok's server keeps its own env identity — sharing an
    // ancestor is not proof the binding is ours.
    repos.agents.upsert({ agentId: RESUMED.agentId, kind: 'claude-code' });
    repos.sessionBindings.upsert(process.ppid, RESUMED.agentId, 'claude-code');
    const grok: AgentIdentity = { agentId: 'grok:55556666', kind: 'grok', origin: 'session' };
    const harness = await connect(repos, grok);
    try {
      const result = await harness.client.callTool({
        name: 'start_work',
        arguments: { task_id: 'T-NESTED', title: 'T-NESTED', kind: 'grok' },
      });
      expect(JSON.stringify(result)).not.toContain('identity_drift');
      expect(repos.tasks.get('T-NESTED')?.agentId).toBe(grok.agentId);
      expect(repos.agents.get(RESUMED.agentId)).toBeDefined();
      expect(repos.agents.get(RESUMED.agentId)?.lastSeen).toBeDefined();
    } finally {
      await close(harness);
    }
  });

  it('keeps the env identity when no hook has bound this client', async () => {
    const harness = await connect(repos, ENV_IDENTITY);
    try {
      const result = await startWork(harness.client, 'T-PLAIN');
      expect(JSON.stringify(result)).not.toContain('identity_drift');
      expect(repos.tasks.get('T-PLAIN')?.agentId).toBe(ENV_IDENTITY.agentId);
    } finally {
      await close(harness);
    }
  });
});
