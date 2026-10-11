import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { workspaceStatus } from '../../src/cli/commands/inbox.js';
import { workspaceIdForRoot } from '../../src/config/paths.js';
import { writeUserConfig } from '../../src/config/user-config.js';
import { hasExplicitRepoRoot, joinClientRoot } from '../../src/workspaces/client-roots.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';

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

  it('keeps a workspace a tool chose while the roots answer was on its way', async () => {
    const launched = dir('launched');
    const open = repoDir('open');
    const manager = new WorkspaceManager(launched);
    let answer: (roots: { roots: { uri: string }[] }) => void = () => undefined;
    const slow = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: () => new Promise<{ roots: { uri: string }[] }>((resolve) => (answer = resolve)),
    };

    const joining = joinClientRoot(slow, manager);
    manager.select();
    answer({ roots: [{ uri: pathToFileURL(open).href }] });

    expect(await joining).toBeUndefined();
    expect(manager.current().repoRoot).toBe(launched);
  });

  it('refuses a folder linked to Concord Cloud instead of serving it locally', async () => {
    const launched = dir('launched');
    const linked = repoDir('linked');
    const manager = new WorkspaceManager(launched);

    const joined = await joinClientRoot(client([pathToFileURL(linked).href]), manager, {
      isCloudLinked: (root) => root === linked,
    });

    expect(joined).toBeUndefined();
    expect(() => manager.select()).toThrow(/linked to Concord Cloud/u);
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

    const fakeConcord = join(home, 'fake-concord');
    writeFileSync(join(home, 'status.json'), JSON.stringify(status));
    writeFileSync(
      fakeConcord,
      `#!/bin/sh\nif [ "$2" = "status" ]; then cat '${join(home, 'status.json')}'; fi\n`,
    );
    chmodSync(fakeConcord, 0o755);
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
