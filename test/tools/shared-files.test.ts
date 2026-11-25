import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, openRepositories, type Repositories } from '../../src/db/index.js';
import { MAX_FILE_BYTES, RETENTION_MS } from '../../src/domain/shared-files.js';
import { createServer } from '../../src/server.js';
import { handleUpdateWork } from '../../src/tools/workflow.js';
import type { AgentMessageDispatcher } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import {
  handleSendWithAttachments,
  readAtMost,
  stageAttachments,
} from '../../src/tools/shared-files.js';

/** No agent has a live session in these tests, so messages wait in the queue. */
const noLiveSession: AgentMessageDispatcher = {
  deliver: () => Promise.reject(new Error('no live session')),
};

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('files shared with agent messages', () => {
  let scratch: string;
  let repos: Repositories;
  let alpha: string;
  let beta: string;
  let workspaceRoot: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'concord-files-'));
    // alpha is this workspace's repository; beta is a linked worktree of it, as in real use.
    alpha = join(scratch, 'alpha');
    beta = join(scratch, 'beta');
    mkdirSync(alpha);
    git(alpha, ['init', '-q']);
    git(alpha, [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ]);
    git(alpha, ['worktree', 'add', '-q', '-b', 'beta', beta]);
    workspaceRoot = realpathSync(alpha);
    repos = createRepositories(openDatabase(':memory:'));
    handleRegisterAgent(repos, {
      agent_id: 'agent-alpha',
      kind: 'claude-code',
      worktree: alpha,
      status: 'active',
    });
    handleRegisterAgent(repos, {
      agent_id: 'agent-beta',
      kind: 'codex',
      worktree: beta,
      status: 'active',
    });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function write(path: string, content: Buffer | string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function send(attachments: string[] | undefined, idempotencyKey = 'key-1') {
    return handleSendWithAttachments(
      repos,
      {
        workspaceRoot,
        operation: 'prompt',
        agentId: 'agent-alpha',
        toAgentId: 'agent-beta',
        content: 'Here is the log',
        idempotencyKey,
        attachments,
      },
      noLiveSession,
    );
  }

  function fileIdOf(messageId: string): string {
    const [file] = repos.sharedFiles.listByMessage(messageId);
    if (file === undefined) throw new Error(`no file stored with ${messageId}`);
    return file.fileId;
  }

  function storedCount(): number {
    return z.number().parse(repos.db.prepare('SELECT COUNT(*) FROM shared_files').pluck().get());
  }

  it('stores exact bytes with the message and references them in its content', async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 0x41]);
    write(join(alpha, 'logs', 'run.log'), bytes);

    const result = await send(['logs/run.log']);
    const files = repos.sharedFiles.listByMessage(result.message.messageId);

    expect(files).toMatchObject([
      {
        filename: 'run.log',
        mediaType: 'text/plain',
        sizeBytes: bytes.length,
        senderAgentId: 'agent-alpha',
      },
    ]);
    expect(result.message.content).toContain('Here is the log');
    expect(result.message.content).toContain(fileIdOf(result.message.messageId));
    expect(result.message.content).toContain('Attached files');
    expect(result.outlook).toContain('Attached 1 file(s)');
  });

  it('refuses files outside the sender worktree, Concord or git state, and links out', async () => {
    write(join(scratch, 'secret.txt'), 'outside');
    write(join(alpha, '.concord', 'state'), 'store');
    write(join(alpha, '.git', 'config'), 'git');

    await expect(send(['../secret.txt'])).rejects.toThrow('outside your worktree');
    await expect(send([join(scratch, 'secret.txt')])).rejects.toThrow('outside your worktree');
    await expect(send(['.concord/state'])).rejects.toThrow('cannot be shared');
    await expect(send(['.git/config'])).rejects.toThrow('cannot be shared');
    if (process.platform !== 'win32') {
      symlinkSync(join(scratch, 'secret.txt'), join(alpha, 'link.txt'));
      await expect(send(['link.txt'])).rejects.toThrow('outside your worktree');
    }
    expect(storedCount()).toBe(0);
  });

  it('refuses too many files, oversized files, and directories', async () => {
    for (let index = 0; index < 6; index += 1) write(join(alpha, `f${String(index)}.txt`), 'x');
    const six = ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt'];
    await expect(send(six)).rejects.toThrow('at most 5 files');

    write(join(alpha, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
    await expect(send(['big.bin'])).rejects.toThrow('larger than the');

    mkdirSync(join(alpha, 'dir'));
    await expect(send(['dir'])).rejects.toThrow('not a regular file');
    expect(storedCount()).toBe(0);
  });

  it('leaves no stored files when the send does not go through', async () => {
    write(join(alpha, 'run.log'), 'data');

    await expect(
      handleSendWithAttachments(
        repos,
        {
          workspaceRoot,
          operation: 'prompt',
          agentId: 'agent-alpha',
          toAgentId: 'agent-nobody',
          content: 'hi',
          idempotencyKey: 'k',
          attachments: ['run.log'],
        },
        noLiveSession,
      ),
    ).rejects.toThrow('not registered');
    expect(storedCount()).toBe(0);
  });

  it('a retried send stores nothing new and reports the files it already has', async () => {
    write(join(alpha, 'run.log'), 'data');
    const first = await send(['run.log'], 'same-key');

    const retry = await send(['run.log'], 'same-key');

    expect(retry.idempotentReplay).toBe(true);
    expect(retry.message.messageId).toBe(first.message.messageId);
    expect(storedCount()).toBe(1);
    expect(retry.outlook).toContain(fileIdOf(first.message.messageId));
  });

  it('removes the bytes once retention ends', async () => {
    write(join(alpha, 'run.log'), 'data');
    const result = await send(['run.log']);
    const fileId = fileIdOf(result.message.messageId);

    repos.sharedFiles.purgeExpired(new Date(Date.now() + RETENTION_MS + 1000).toISOString());

    const stored = repos.sharedFiles.get(fileId);
    expect(stored?.content).toBeNull();
    expect(stored?.purgedAt).not.toBeNull();
  });
  it('sends without attachments exactly as before', async () => {
    const result = await send(undefined);

    expect(result.message.content).toBe('Here is the log');
    expect(storedCount()).toBe(0);
  });

  it('rejects attachments on a task record, which is not a message', () => {
    expect(() =>
      handleUpdateWork(
        repos,
        { content: 'progress note', attachments: ['run.log'], agent_id: 'agent-alpha' },
        noLiveSession,
      ),
    ).toThrow('attachments apply only with update_work operation prompt or reply.');
  });

  it('a failed send stores nothing, and retrying with the same key works once the recipient exists', async () => {
    const late = join(scratch, 'late');
    git(alpha, ['worktree', 'add', '-q', '-b', 'late', late]);
    write(join(alpha, 'run.log'), 'data');
    const sendTo = (to: string) =>
      handleSendWithAttachments(
        repos,
        {
          workspaceRoot,
          operation: 'prompt',
          agentId: 'agent-alpha',
          toAgentId: to,
          content: 'Here is the log',
          idempotencyKey: 'retry-1',
          attachments: ['run.log'],
        },
        noLiveSession,
      );

    await expect(sendTo('agent-late')).rejects.toThrow('not registered');
    expect(storedCount()).toBe(0);

    handleRegisterAgent(repos, {
      agent_id: 'agent-late',
      kind: 'cursor',
      worktree: late,
      status: 'active',
    });
    const retried = await sendTo('agent-late');

    expect(retried.idempotentReplay).toBe(false);
    expect(storedCount()).toBe(1);
    expect(retried.message.content).toContain(fileIdOf(retried.message.messageId));
  });
  it('resolves a relative path from the folder the agent registered, not the checkout root', async () => {
    const api = join(alpha, 'packages', 'api');
    write(join(alpha, 'run.log'), 'root log');
    write(join(api, 'run.log'), 'api log');
    handleRegisterAgent(repos, {
      agent_id: 'agent-api',
      kind: 'claude-code',
      worktree: api,
      status: 'active',
    });

    const result = await handleSendWithAttachments(
      repos,
      {
        workspaceRoot,
        operation: 'prompt',
        agentId: 'agent-api',
        toAgentId: 'agent-beta',
        content: 'the api log',
        idempotencyKey: 'nested',
        attachments: ['run.log'],
      },
      noLiveSession,
    );

    const [file] = repos.sharedFiles.listByMessage(result.message.messageId);
    expect(repos.sharedFiles.get(file?.fileId ?? '')?.content?.toString()).toBe('api log');
  });

  it('keeps expects_reply false when a prompt carries attachments', async () => {
    write(join(alpha, 'run.log'), 'data');

    const result = await handleSendWithAttachments(
      repos,
      {
        workspaceRoot,
        operation: 'prompt',
        agentId: 'agent-alpha',
        toAgentId: 'agent-beta',
        content: 'FYI, no reply needed',
        idempotencyKey: 'no-reply',
        expectsReply: false,
        attachments: ['run.log'],
      },
      noLiveSession,
    );

    expect(result.message.expectsReply).toBe(false);
  });

  it('removes expired bytes when the store opens, not only on the next send', () => {
    const databasePath = join(scratch, 'store.db');
    const first = openRepositories(databasePath);
    first.sharedFiles.createMany([
      {
        fileId: 'f_expired',
        messageId: 'm-old',
        senderAgentId: 'agent-alpha',
        filename: 'old.log',
        mediaType: 'text/plain',
        sizeBytes: 3,
        sha256: '0'.repeat(64),
        content: Buffer.from('old'),
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    ]);
    first.db.close();

    const reopened = openRepositories(databasePath);
    try {
      expect(reopened.sharedFiles.get('f_expired')?.content).toBeNull();
    } finally {
      // Windows cannot delete the scratch folder while the database file is open.
      reopened.db.close();
    }
  });

  function endpointFor(agentId: string, capabilities: string[]): void {
    repos.agentEndpoints.upsert({
      endpointId: `${agentId}-live`,
      agentId,
      provider: 'codex',
      transport: 'local-ipc',
      capabilities,
      address: 'unused',
      credentialHash: 'unused',
      status: 'connected',
    });
  }

  it('keeps the files when delivery fails after the recipient has read the message', async () => {
    write(join(alpha, 'run.log'), 'data');
    endpointFor('agent-beta', ['inject']);
    const readThenFail: AgentMessageDispatcher = {
      deliver: ({ message }) => {
        // The recipient reads the message, then the push reports an error.
        repos.db
          .prepare("UPDATE agent_messages SET status = 'read', read_at = ? WHERE message_id = ?")
          .run(new Date().toISOString(), message.messageId);
        return Promise.reject(new Error('push failed'));
      },
    };

    await expect(
      handleSendWithAttachments(
        repos,
        {
          workspaceRoot,
          operation: 'prompt',
          agentId: 'agent-alpha',
          toAgentId: 'agent-beta',
          content: 'the log',
          idempotencyKey: 'read-then-fail',
          attachments: ['run.log'],
        },
        readThenFail,
      ),
    ).rejects.toThrow('Immediate delivery failed');
    expect(storedCount()).toBe(1);
  });

  it('removes the files when delivery fails and the message is marked failed', async () => {
    write(join(alpha, 'run.log'), 'data');
    endpointFor('agent-beta', ['inject']);
    const failing: AgentMessageDispatcher = {
      deliver: () => Promise.reject(new Error('push failed')),
    };

    await expect(
      handleSendWithAttachments(
        repos,
        {
          workspaceRoot,
          operation: 'prompt',
          agentId: 'agent-alpha',
          toAgentId: 'agent-beta',
          content: 'the log',
          idempotencyKey: 'fail-unread',
          attachments: ['run.log'],
        },
        failing,
      ),
    ).rejects.toThrow('Immediate delivery failed');
    expect(storedCount()).toBe(0);
  });

  it('refuses to read through a link to a file outside the checkout', () => {
    const outside = join(scratch, 'outside.txt');
    write(outside, 'secret');
    const link = join(workspaceRoot, 'linked.txt');
    symlinkSync(outside, link);

    expect(() => readAtMost(link, 100, workspaceRoot)).toThrow();
  });

  it('refuses git and Concord folders whatever the case of their names', async () => {
    // On Windows and macOS `.GIT` is the same folder as `.git`, which already exists.
    if (!existsSync(join(alpha, '.GIT', 'HEAD')))
      write(join(alpha, '.GIT', 'HEAD'), 'ref: refs/heads/main\n');
    write(join(alpha, '.Concord', 'state.txt'), 'state');

    for (const attachment of ['.GIT/HEAD', '.Concord/state.txt']) {
      await expect(
        handleSendWithAttachments(
          repos,
          {
            workspaceRoot,
            operation: 'prompt',
            agentId: 'agent-alpha',
            toAgentId: 'agent-beta',
            content: 'state',
            idempotencyKey: `case-${attachment}`,
            attachments: [attachment],
          },
          noLiveSession,
        ),
      ).rejects.toThrow('cannot be shared');
    }
    expect(storedCount()).toBe(0);
  });

  it('refuses a folder whose .git file points at a worktree that git does not list', async () => {
    const fake = join(alpha, 'fake');
    write(join(fake, '.git'), `gitdir: ${join(alpha, '.git', 'worktrees', 'beta')}\n`);
    write(join(fake, 'run.log'), 'data');
    handleRegisterAgent(repos, {
      agent_id: 'agent-fake',
      kind: 'claude-code',
      worktree: fake,
      status: 'active',
    });

    await expect(
      handleSendWithAttachments(
        repos,
        {
          workspaceRoot,
          operation: 'prompt',
          agentId: 'agent-fake',
          toAgentId: 'agent-beta',
          content: 'log',
          idempotencyKey: 'fake-worktree',
          attachments: ['run.log'],
        },
        noLiveSession,
      ),
    ).rejects.toThrow('is not a checkout of this repository');
  });

  it('purging a file twice removes it only once', async () => {
    write(join(alpha, 'run.log'), 'data');
    await send(['run.log']);
    const later = new Date(Date.now() + RETENTION_MS + 1000).toISOString();

    expect(repos.sharedFiles.purgeExpired(later)).toBe(1);
    expect(repos.sharedFiles.purgeExpired(later)).toBe(0);
  });

  it('reads at most one byte past a limit, however large the file', () => {
    write(join(workspaceRoot, 'long.txt'), 'x'.repeat(100));

    expect(readAtMost(join(workspaceRoot, 'long.txt'), 10, workspaceRoot)).toHaveLength(11);
    expect(readAtMost(join(workspaceRoot, 'long.txt'), 200, workspaceRoot)).toHaveLength(100);
  });

  it('accepts attachments through update_work over MCP and refuses files outside the worktree', async () => {
    write(join(alpha, 'run.log'), 'data');
    write(join(scratch, 'secret.txt'), 'outside');
    const server = createServer(repos, {
      identity: { agentId: 'agent-alpha', kind: 'claude-code', origin: 'operator' },
      workspaceRoot,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'shared-files-test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const sent = await client.callTool({
        name: 'update_work',
        arguments: {
          operation: 'prompt',
          to_agent_id: 'agent-beta',
          content: 'See the log',
          idempotency_key: 'mcp-1',
          attachments: ['run.log'],
        },
      });
      expect(sent.isError).not.toBe(true);
      expect(JSON.stringify(sent.content)).toContain('Attached 1 file(s)');

      const refused = await client.callTool({
        name: 'update_work',
        arguments: {
          operation: 'prompt',
          to_agent_id: 'agent-beta',
          content: 'And this',
          idempotency_key: 'mcp-2',
          attachments: ['../secret.txt'],
        },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('outside your worktree');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses a registered worktree that is not a checkout of this repository', () => {
    const stray = join(scratch, 'stray');
    mkdirSync(stray);
    write(join(stray, 'id_ed25519'), 'key');
    handleRegisterAgent(repos, {
      agent_id: 'agent-stray',
      kind: 'claude-code',
      worktree: stray,
      status: 'active',
    });

    expect(() =>
      stageAttachments(repos, 'agent-stray', ['id_ed25519'], 'key-stray', workspaceRoot),
    ).toThrow('is not a checkout of this repository');
    expect(storedCount()).toBe(0);
  });
});
