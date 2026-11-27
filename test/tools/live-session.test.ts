import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { workspaceIdForRoot } from '../../src/config/paths.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import { liveSession } from '../../src/tools/live-session.js';
import type { AgentIdentity } from '../../src/domain/identity.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';

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

function repoDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `concord-live-session-${label}-`));
  mkdirSync(join(root, '.git'));
  return realpathSync(root);
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

  it('keeps an established binding when roster expiry archives the agent', async () => {
    // An idle resumed session outlives the roster's archive window while its
    // monitor is stopped; the binding is still the client's live identity, so
    // falling back to the env identity would resurrect the abandoned agent.
    repos.agents.upsert(
      { agentId: RESUMED.agentId, kind: 'claude-code' },
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    );
    repos.sessionBindings.upsert(process.ppid, RESUMED.agentId, 'claude-code');
    const harness = await connect(repos, ENV_IDENTITY);
    try {
      const result = await startWork(harness.client, 'T-ARCHIVED');
      expect(JSON.stringify(result)).toContain('identity_drift');
      expect(repos.tasks.get('T-ARCHIVED')?.agentId).toBe(RESUMED.agentId);
    } finally {
      await close(harness);
    }
  });

  it('acts as the established session when a call selects another workspace', async () => {
    const firstRoot = repoDir('first');
    const secondRoot = repoDir('second');
    const manager = new WorkspaceManager(firstRoot);
    manager.join(secondRoot);
    const first = manager.select(workspaceIdForRoot(firstRoot)).repos;
    const second = manager.select(workspaceIdForRoot(secondRoot)).repos;
    first.agents.upsert({ agentId: RESUMED.agentId, kind: 'claude-code' });
    first.sessionBindings.upsert(process.ppid, RESUMED.agentId, 'claude-code');

    const server = createServer(second, {
      identity: ENV_IDENTITY,
      workspaceManager: manager,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'live-session-workspaces-test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      await client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'T-FIRST',
          title: 'T-FIRST',
          kind: 'claude-code',
          workspace_id: workspaceIdForRoot(firstRoot),
        },
      });
      await client.callTool({
        name: 'start_work',
        arguments: {
          task_id: 'T-SECOND',
          title: 'T-SECOND',
          kind: 'claude-code',
          workspace_id: workspaceIdForRoot(secondRoot),
        },
      });

      expect(first.tasks.get('T-FIRST')?.agentId).toBe(RESUMED.agentId);
      expect(second.tasks.get('T-SECOND')?.agentId).toBe(RESUMED.agentId);
      expect(second.agents.get(ENV_IDENTITY.agentId)).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
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

describe('live session lookup', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    repos.agents.upsert({ agentId: RESUMED.agentId, kind: 'claude-code' });
    repos.agents.upsert({ agentId: ENV_IDENTITY.agentId, kind: 'claude-code' });
  });

  it('keeps a live identity it established when a later workspace has no binding', () => {
    const other = createRepositories(openDatabase(':memory:'));
    repos.sessionBindings.upsert(42, RESUMED.agentId, 'claude-code');
    const session = liveSession(ENV_IDENTITY, undefined, { ancestors: () => [42] });

    expect(session.sessionForRequest(other, undefined)?.agentId).toBe(ENV_IDENTITY.agentId);
    expect(session.sessionForRequest(repos, undefined)?.agentId).toBe(RESUMED.agentId);
    expect(session.sessionForRequest(other, undefined)?.agentId).toBe(RESUMED.agentId);
  });

  it('lets a newer binding replace one established in another workspace', () => {
    const other = createRepositories(openDatabase(':memory:'));
    const nextAgentId = 'claude-code:cccc3333';
    other.agents.upsert({ agentId: nextAgentId, kind: 'claude-code' });
    repos.sessionBindings.upsert(42, RESUMED.agentId, 'claude-code', '2026-01-01T00:00:02.000Z');
    other.sessionBindings.upsert(42, nextAgentId, 'claude-code', '2026-01-01T00:00:03.000Z');
    const session = liveSession(ENV_IDENTITY, undefined, {
      ancestors: () => [42],
      startedAt: Date.parse('2026-01-01T00:00:01.000Z'),
    });

    expect(session.sessionForRequest(repos, undefined)?.agentId).toBe(RESUMED.agentId);
    expect(session.sessionForRequest(other, undefined)?.agentId).toBe(nextAgentId);
    expect(session.sessionForRequest(repos, undefined)?.agentId).toBe(nextAgentId);
  });

  it('trusts an ancestor binding only while the server lived to see it written', () => {
    // Server spawned at t=1000 under an unbound shim (10); its client (20) was
    // bound at t=2000 by a /resume — the row postdates the server, so it wins.
    const resumed = liveSession(ENV_IDENTITY, undefined, {
      ancestors: () => [10, 20],
      startedAt: 1000,
    });
    repos.sessionBindings.upsert(20, RESUMED.agentId, 'claude-code', '1970-01-01T00:00:02.000Z');
    expect(resumed.sessionForRequest(repos, undefined)?.agentId).toBe(RESUMED.agentId);

    // Same layout, but the binding predates the server: it belongs to a
    // session the spawn-time environment already names — a nested client
    // keeps its own identity rather than adopting an outer session’s.
    const nested = liveSession(ENV_IDENTITY, undefined, {
      ancestors: () => [10, 20],
      startedAt: 3000,
    });
    expect(nested.sessionForRequest(repos, undefined)?.agentId).toBe(ENV_IDENTITY.agentId);
  });

  it('lets a stale binding on the nearest ancestor end the search', () => {
    // The client (10) still carries its pre-spawn binding; the row a deeper
    // session just refreshed must not be reached past it.
    repos.sessionBindings.upsert(
      10,
      ENV_IDENTITY.agentId,
      'claude-code',
      '1970-01-01T00:00:01.000Z',
    );
    repos.sessionBindings.upsert(20, RESUMED.agentId, 'claude-code', '1970-01-01T00:00:05.000Z');
    const session = liveSession(ENV_IDENTITY, undefined, {
      ancestors: () => [10, 20],
      startedAt: 3000,
    });

    expect(session.sessionForRequest(repos, undefined)?.agentId).toBe(ENV_IDENTITY.agentId);
  });
});
