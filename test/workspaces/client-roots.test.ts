import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { workspaceStatus } from '../../src/cli/commands/inbox.js';
import { workspaceIdForRoot } from '../../src/config/paths.js';
import { writeUserConfig } from '../../src/config/user-config.js';
import { hasExplicitRepoRoot, joinClientRoot } from '../../src/workspaces/client-roots.js';
import { registerWorkflowTools } from '../../src/tools/workflow.js';
import {
  type WorkspaceContext,
  WorkspaceManager,
  routedRepositories,
} from '../../src/workspaces/manager.js';
import { writeFakeCommand } from '../helpers/fake-command.js';

function dir(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `concord-${label}-`)));
}

function repoDir(label: string): string {
  const root = dir(label);
  mkdirSync(join(root, '.git'));
  return root;
}

function client(roots: readonly string[] | undefined) {
  return {
    getClientCapabilities: () => (roots === undefined ? {} : { roots: {} }),
    listRoots: () => Promise.resolve({ roots: (roots ?? []).map((uri) => ({ uri })) }),
  };
}

/**
 * A workflow server whose one live delivery runs `duringDelivery` before it
 * resolves, and a call that sends `codex:sender`'s prompt to `codex:target`.
 */
async function deliveryServer(
  duringDelivery: (manager: WorkspaceManager) => void,
  onWrite?: (workspace?: WorkspaceContext) => void,
) {
  const launched = repoDir('launched');
  // A fresh home keeps the store in the repository, whatever this machine's global mode.
  const manager = WorkspaceManager.fromEnvironment(launched, { HOME: dir('home') });
  const repos = manager.current().repos;
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
    endpointId: 'e1',
    agentId: 'codex:target',
    provider: 'codex',
    transport: 'local-ipc',
    capabilities: ['local-ipc', 'steer'],
    address: 'ipc',
    credentialHash: 'h',
    status: 'connected',
    expiresAt: null,
  });
  const server = new McpServer({ name: 'test', version: '0' });
  const deliver = () => {
    duringDelivery(manager);
    return Promise.resolve({ provider: 'codex', delivery: 'steer' as const });
  };
  registerWorkflowTools(
    server,
    routedRepositories(manager),
    onWrite,
    (id) => manager.select(id),
    { agentId: 'codex:sender', kind: 'codex', origin: 'session' },
    undefined,
    { deliver },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0' });
  await Promise.all([mcp.connect(clientSide), server.connect(serverSide)]);
  const prompt = async () => {
    try {
      return await mcp.callTool({
        name: 'update_work',
        arguments: {
          operation: 'prompt',
          agent_id: 'codex:sender',
          to_agent_id: 'codex:target',
          content: 'hi',
          idempotency_key: 'k1',
        },
      });
    } finally {
      await mcp.close();
    }
  };
  return { launched, manager, repos, prompt };
}

describe('joinClientRoot', () => {
  it("joins the client's first folder when the server started elsewhere", async () => {
    const launched = dir('launched');
    const open = repoDir('open');
    const manager = new WorkspaceManager(launched);

    const joined = await joinClientRoot(
      client(['https://example.com/not-a-folder', pathToFileURL(open).href]),
      manager,
    );

    expect(joined?.repoRoot).toBe(open);
    expect(manager.current().repoRoot).toBe(open);
  });

  it('keeps the working directory for a client without roots', async () => {
    const launched = dir('launched');
    const manager = new WorkspaceManager(launched);
    expect(await joinClientRoot(client(undefined), manager)).toBeUndefined();
    expect(manager.current().repoRoot).toBe(launched);
  });

  it('keeps a workspace a tool named while the roots answer was on its way', async () => {
    const launched = dir('launched');
    const open = repoDir('open');
    const named = repoDir('named');
    const manager = new WorkspaceManager(launched);
    let answer: (roots: { roots: { uri: string }[] }) => void = () => undefined;
    const slow = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: () => new Promise<{ roots: { uri: string }[] }>((resolve) => (answer = resolve)),
    };

    const joining = joinClientRoot(slow, manager);
    manager.select();
    expect(manager.current().repoRoot).toBe(launched);
    answer({ roots: [{ uri: pathToFileURL(open).href }] });
    expect((await joining)?.repoRoot).toBe(open);

    const rejoining = joinClientRoot(slow, manager);
    manager.select(workspaceIdForRoot(named));
    answer({ roots: [{ uri: pathToFileURL(open).href }] });
    expect(await rejoining).toBeUndefined();
    expect(manager.current().repoRoot).toBe(named);
  });

  it('keeps a live delivery in the workspace it started in when the folder joins meanwhile', async () => {
    const open = repoDir('open');
    const { manager, repos, prompt } = await deliveryServer((manager) => {
      manager.join(open);
    });

    const sent = await prompt();

    expect(sent.isError).not.toBe(true);
    expect(manager.current().repoRoot).toBe(open);
    expect(repos.agentMessages.listByAgent('codex:target').map((m) => m.status)).toEqual([
      'delivered',
    ]);
  });

  it('reports a delivered message as sent when a cloud refusal lands meanwhile', async () => {
    const written: string[] = [];
    const { launched, manager, repos, prompt } = await deliveryServer(
      (manager) => {
        manager.refuse('works through Concord Cloud');
      },
      (workspace) => written.push((workspace ?? manager.current()).repoRoot),
    );

    const sent = await prompt();

    expect(sent.isError).not.toBe(true);
    expect(written).toEqual([launched]);
    expect(repos.agentMessages.listByAgent('codex:target').map((m) => m.status)).toEqual([
      'delivered',
    ]);
  });

  it('refuses a folder linked to Concord Cloud instead of serving it locally', async () => {
    const launched = dir('launched');
    const linked = repoDir('linked');
    const manager = new WorkspaceManager(launched);

    const joined = await joinClientRoot(client([pathToFileURL(linked).href]), manager, {
      isCloudLinked: (root) => root === linked,
    });

    expect(joined).toBeUndefined();
    expect(() => manager.select()).toThrow(/works through Concord Cloud/u);
    // Telemetry still reads a root without throwing, so the refusal reaches the client.
    expect(manager.activeRoot).toBeUndefined();
  });

  it('does not second-guess a repository the environment names', () => {
    expect(hasExplicitRepoRoot({ CLAUDE_PROJECT_DIR: '/repo' })).toBe(true);
    expect(hasExplicitRepoRoot({ CONCORD_REPO_ROOT: ' ' })).toBe(false);
  });
});

describe('Cursor session context', () => {
  it('gives the workspace id, and instructions for a repository in the global store', () => {
    const home = dir('home');
    writeUserConfig({ HOME: home }, { globalMode: true });
    const root = repoDir('cursor-global');
    const env = { HOME: home, CONCORD_REPO_ROOT: root };
    const status = workspaceStatus(root, env);
    expect(status).toMatchObject({ workspace_id: workspaceIdForRoot(root), store: 'global' });
    expect(status['instructions']).toContain('start_work');

    const fakeConcord = writeFakeCommand(
      home,
      'fake-concord',
      `if (process.argv[3] === 'status') process.stdout.write(${JSON.stringify(JSON.stringify(status))});\n`,
    );
    const hook = join(process.cwd(), 'plugin', 'cursor', 'concord-relay', 'cursor-hook.mjs');
    const result = spawnSync(process.execPath, [hook, 'session-start'], {
      env: { ...process.env, CONCORD_EXECUTABLE: fakeConcord },
      input: JSON.stringify({ conversation_id: 'cursor-global', workspace_roots: [root] }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const raw: unknown = JSON.parse(result.stdout);
    const context = z.object({ additional_context: z.string() }).parse(raw).additional_context;
    expect(context).toContain(`workspace_id "${workspaceIdForRoot(root)}"`);
    expect(context).toContain('start_work');
  });

  it('adds no instructions for a set-up repository, which has its own rule file', () => {
    const root = repoDir('cursor-local');
    mkdirSync(join(root, '.concord'));
    writeFileSync(join(root, '.concord', 'concord.db'), '');
    const status = workspaceStatus(root, { HOME: dir('home'), CONCORD_REPO_ROOT: root });
    expect(status).toEqual({ workspace_id: workspaceIdForRoot(root), store: 'local' });
  });
});
