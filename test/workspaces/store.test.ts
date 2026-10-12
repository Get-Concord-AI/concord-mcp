import {
  existsSync,
  mkdirSync,
  watch,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readUserConfig, writeUserConfig } from '../../src/config/user-config.js';
import { createRepositories, openDatabase, openRepositories } from '../../src/db/index.js';
import { registerPullEndpoint, workspaceExists } from '../../src/cli/commands/inbox.js';
import { watchedDirectory } from '../../src/cli/commands/watch.js';
import { openContext } from '../../src/cli/context.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { GENERAL_PROJECT, artifactDirName, resolveStore } from '../../src/workspaces/store.js';

function dir(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `concord-${label}-`)));
}

function repoDir(label: string): string {
  const root = dir(label);
  mkdirSync(join(root, '.git'));
  return root;
}

function globalEnv(): { HOME: string } {
  const env = { HOME: dir('home') };
  writeUserConfig(env, { globalMode: true });
  return env;
}

const noRemote = (): undefined => undefined;

const task = {
  taskId: 'TASK-1',
  title: 'Same id in two repositories',
  owner: null,
  agent: null,
  branch: null,
  worktree: null,
  expectedFiles: [],
  modules: [],
  domains: [],
  riskTags: [],
  notes: null,
  parentTaskId: null,
  agentId: null,
} as const;

describe('resolveStore', () => {
  it("keeps today's repository store while global mode is off", () => {
    const root = repoDir('off');
    const store = resolveStore(root, { HOME: dir('home') }, noRemote);
    expect(store).toMatchObject({ kind: 'local', project: '' });
    expect(store.databasePath).toBe(join(root, '.concord', 'concord.db'));
  });

  it('names a repository in the machine-wide store by its git remote', () => {
    const env = globalEnv();
    const store = resolveStore(repoDir('remote'), env, () => 'git@github.com:Org/Repo.git');
    expect(store).toMatchObject({ kind: 'global', project: 'github.com/org/repo' });
    expect(store.databasePath).toBe(join(env.HOME, '.concord', 'global.db'));
    expect(store.concordPath).toMatch(/[/\\]projects[/\\]github.com-org-repo-[0-9a-f]{8}$/u);
  });

  it('names a repository without a remote by its path, and no repository as general', () => {
    const env = globalEnv();
    const root = repoDir('no-remote');
    expect(resolveStore(root, env, noRemote).project).toBe(root);
    expect(resolveStore(dir('scratch'), env, noRemote).project).toBe(GENERAL_PROJECT);
  });

  it('keeps artifact directory names short for deeply nested repositories', () => {
    const deep = `/${'nested-directory/'.repeat(30)}repo`;
    const name = artifactDirName(deep);
    expect(name.length).toBeLessThanOrEqual(73);
    expect(name).toMatch(/directory-repo-[0-9a-f]{8}$/u);
    expect(artifactDirName(`${deep}2`)).not.toBe(name);
  });

  it('keeps a set-up repository in its own store even with global mode on', () => {
    const root = repoDir('set-up');
    openRepositories(join(root, '.concord', 'concord.db')).db.close();
    expect(resolveStore(root, globalEnv(), noRemote).kind).toBe('local');
  });
});

describe('messages across projects', () => {
  it("keep a reply on the prompt's task, not the replier's task of the same id", () => {
    const db = openDatabase(':memory:');
    const first = createRepositories(db, 'github.com/org/a');
    const second = createRepositories(db, 'github.com/org/b');
    registerPullEndpoint(first, 'codex:a', 'codex');
    registerPullEndpoint(first, 'codex:b', 'codex');
    first.tasks.create({ ...task, title: 'A' });

    for (const [round, secondHasTask] of [false, true].entries()) {
      if (secondHasTask) second.tasks.create({ ...task, title: 'B' });
      const prompt = handleSendAgentMessage(first, {
        operation: 'prompt',
        agentId: 'codex:a',
        toAgentId: 'codex:b',
        taskId: 'TASK-1',
        content: 'Which schema?',
        idempotencyKey: `prompt-${String(round)}`,
      }).message;
      second.agentMessages.claimPendingForRecipient('codex:b', 'codex');
      const { message: reply, task: replyTask } = handleSendAgentMessage(second, {
        operation: 'reply',
        agentId: 'codex:b',
        replyToMessageId: prompt.messageId,
        content: 'The new one.',
        idempotencyKey: `reply-${String(round)}`,
      });

      expect(reply).toMatchObject({ project: 'github.com/org/a', taskId: 'TASK-1' });
      expect(replyTask?.title).toBe('A');
      expect(first.agentMessages.listByTask('TASK-1')).toContainEqual(reply);
      expect(second.agentMessages.listByTask('TASK-1')).toEqual([]);
    }
  });
});

describe('inbox hooks', () => {
  it('serve a global workspace before its database exists, but not an unset-up repo', () => {
    const root = repoDir('first-session');
    const env = { ...globalEnv(), CONCORD_REPO_ROOT: root };
    expect(existsSync(join(env.HOME, '.concord', 'global.db'))).toBe(false);
    expect(workspaceExists(root, env)).toBe(true);
    expect(workspaceExists(root, { HOME: dir('home'), CONCORD_REPO_ROOT: root })).toBe(false);
  });
});

describe('user config', () => {
  it('reads a missing or malformed file as no choice made', () => {
    const env = { HOME: dir('home') };
    expect(readUserConfig(env)).toEqual({});
    mkdirSync(join(env.HOME, '.concord'), { recursive: true });
    writeFileSync(join(env.HOME, '.concord', 'config.json'), '{not json');
    expect(readUserConfig(env)).toEqual({});
  });

  it('merges a choice into the file, keeping keys it does not know', () => {
    const env = { HOME: dir('home') };
    const path = join(env.HOME, '.concord', 'config.json');
    mkdirSync(join(env.HOME, '.concord'), { recursive: true });
    writeFileSync(path, '{"futureSetting":1}');
    writeUserConfig(env, { globalMode: false });
    expect(readUserConfig(env)).toEqual({ globalMode: false });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ futureSetting: 1, globalMode: false });
  });
});

describe('global mode end to end', () => {
  it('puts two repositories in one store without writing into either', () => {
    const env = globalEnv();
    const first = repoDir('first');
    const second = repoDir('second');
    const manager = WorkspaceManager.fromEnvironment(first, env);

    manager.current().repos.tasks.create(task);
    manager.join(second);
    manager.current().repos.tasks.create({ ...task, title: 'Second repository' });

    expect(
      manager
        .current()
        .repos.tasks.list()
        .map((entry) => entry.title),
    ).toEqual(['Second repository']);
    expect(existsSync(join(first, '.concord'))).toBe(false);
    expect(existsSync(join(second, '.concord'))).toBe(false);

    const cli = openContext(first, { ...env, CONCORD_REPO_ROOT: first });
    expect(cli.store.kind).toBe('global');
    expect(cli.repos.tasks.get('TASK-1')?.title).toBe('Same id in two repositories');
  });

  it('lets concord watch follow database writes before any artifact is written', async () => {
    const root = repoDir('watch');
    const ctx = openContext(root, { ...globalEnv(), CONCORD_REPO_ROOT: root });
    expect(existsSync(ctx.concordPath)).toBe(false);
    const changed = new Promise<void>((resolve) => {
      const watcher = watch(watchedDirectory(ctx), () => {
        watcher.close();
        resolve();
      });
    });
    ctx.repos.tasks.create(task);
    await changed;
  });

  it('opens the repository store when asked to, as setup does', () => {
    const env = globalEnv();
    const root = repoDir('setup');
    const ctx = openContext(root, { ...env, CONCORD_REPO_ROOT: root }, { local: true });
    expect(ctx.store.kind).toBe('local');
    expect(existsSync(join(root, '.concord', 'concord.db'))).toBe(true);
  });
});
