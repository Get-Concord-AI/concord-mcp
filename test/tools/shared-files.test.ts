import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { MAX_FILE_BYTES, RETENTION_MS } from '../../src/domain/shared-files.js';
import { createServer } from '../../src/server.js';
import { handleUpdateWork } from '../../src/tools/workflow.js';
import type { AgentMessageDispatcher } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import { fetchSharedFile, handleSendWithAttachments } from '../../src/tools/shared-files.js';

/** No agent has a live session in these tests, so messages wait in the queue. */
const noLiveSession: AgentMessageDispatcher = {
  deliver: () => Promise.reject(new Error('no live session')),
};

describe('files shared with agent messages', () => {
  let scratch: string;
  let repos: Repositories;
  let alpha: string;
  let beta: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'concord-files-'));
    alpha = join(scratch, 'alpha');
    beta = join(scratch, 'beta');
    mkdirSync(alpha);
    mkdirSync(beta);
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

  function storedCount(): unknown {
    return repos.db.prepare('SELECT COUNT(*) FROM shared_files').pluck().get();
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
    expect(result.message.content).toContain('concord files get <file-id> --to <path>');
    expect(result.outlook).toContain('Attached 1 file(s)');
  });

  it('lets the recipient save the exact bytes into its own worktree', async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
    write(join(alpha, 'run.log'), bytes);
    const result = await send(['run.log']);

    const saved = fetchSharedFile(repos, {
      fileId: fileIdOf(result.message.messageId),
      agentId: 'agent-beta',
      destination: 'incoming/run.log',
    });

    expect(saved.path).toBe(join(realpathSync(beta), 'incoming', 'run.log'));
    expect(readFileSync(saved.path)).toEqual(bytes);
    expect(saved.sha256).toBe(repos.sharedFiles.listByMessage(result.message.messageId)[0]?.sha256);
  });

  it('lets the sender retrieve its own file and refuses any other agent', async () => {
    const gamma = join(scratch, 'gamma');
    mkdirSync(gamma);
    handleRegisterAgent(repos, {
      agent_id: 'agent-gamma',
      kind: 'cursor',
      worktree: gamma,
      status: 'active',
    });
    write(join(alpha, 'run.log'), 'data');
    const result = await send(['run.log']);
    const fileId = fileIdOf(result.message.messageId);

    expect(
      fetchSharedFile(repos, { fileId, agentId: 'agent-alpha', destination: 'copy.log' }).filename,
    ).toBe('run.log');
    expect(() =>
      fetchSharedFile(repos, { fileId, agentId: 'agent-gamma', destination: 'run.log' }),
    ).toThrow(`No shared file ${fileId} is available to agent-gamma.`);
    expect(existsSync(join(gamma, 'run.log'))).toBe(false);
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
    await expect(send(['big.bin'])).rejects.toThrow('the limit is');

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

  it('removes the bytes once retention ends and refuses retrieval after that', async () => {
    write(join(alpha, 'run.log'), 'data');
    const result = await send(['run.log']);
    const fileId = fileIdOf(result.message.messageId);

    const afterRetention = Date.now() + RETENTION_MS + 1000;
    expect(() =>
      fetchSharedFile(
        repos,
        { fileId, agentId: 'agent-beta', destination: 'run.log' },
        afterRetention,
      ),
    ).toThrow('was removed');

    const stored = repos.sharedFiles.get(fileId);
    expect(stored?.content).toBeNull();
    expect(stored?.purgedAt).not.toBeNull();
    expect(existsSync(join(beta, 'run.log'))).toBe(false);
  });

  it('never overwrites a file and never writes outside the reader worktree', async () => {
    write(join(alpha, 'run.log'), 'new');
    const result = await send(['run.log']);
    const fileId = fileIdOf(result.message.messageId);
    write(join(beta, 'run.log'), 'mine');

    expect(() =>
      fetchSharedFile(repos, { fileId, agentId: 'agent-beta', destination: 'run.log' }),
    ).toThrow('already exists');
    expect(readFileSync(join(beta, 'run.log'), 'utf8')).toBe('mine');

    expect(() =>
      fetchSharedFile(repos, { fileId, agentId: 'agent-beta', destination: '../escape.log' }),
    ).toThrow('outside your worktree');
    expect(() =>
      fetchSharedFile(repos, {
        fileId,
        agentId: 'agent-beta',
        destination: join(scratch, 'escape.log'),
      }),
    ).toThrow('outside your worktree');
    expect(existsSync(join(scratch, 'escape.log'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'does not write through a symlinked folder that leads out of the worktree',
    async () => {
      write(join(alpha, 'run.log'), 'data');
      const fileId = fileIdOf((await send(['run.log'])).message.messageId);
      symlinkSync(scratch, join(beta, 'out'));

      expect(() =>
        fetchSharedFile(repos, { fileId, agentId: 'agent-beta', destination: 'out/run.log' }),
      ).toThrow('outside your worktree');
      expect(existsSync(join(scratch, 'run.log'))).toBe(false);
    },
  );

  it('detects stored bytes that no longer match their checksum and saves nothing', async () => {
    write(join(alpha, 'run.log'), 'data');
    const fileId = fileIdOf((await send(['run.log'])).message.messageId);
    repos.db
      .prepare('UPDATE shared_files SET content = ? WHERE file_id = ?')
      .run(Buffer.from('tampered'), fileId);

    expect(() =>
      fetchSharedFile(repos, { fileId, agentId: 'agent-beta', destination: 'run.log' }),
    ).toThrow('failed its checksum');
    expect(existsSync(join(beta, 'run.log'))).toBe(false);
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

  it('accepts attachments through update_work over MCP and refuses files outside the worktree', async () => {
    write(join(alpha, 'run.log'), 'data');
    write(join(scratch, 'secret.txt'), 'outside');
    const server = createServer(repos, {
      identity: { agentId: 'agent-alpha', kind: 'claude-code', origin: 'operator' },
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
});
