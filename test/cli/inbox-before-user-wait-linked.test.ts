import { Command } from '@commander-js/extra-typings';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureMachineKey, writeCredentials } from '../../src/cloud/settings.js';
import { registerInboxCommand } from '../../src/cli/commands/inbox.js';
import { fakeCloud, ok } from '../cloud/fake-cloud.js';

const AGENT = 'claude-code:aaaa1111';

/** `concord inbox drain` on a machine linked to a Cloud that has one message queued. */
describe('the pre-question drain on a linked machine', () => {
  let cloud: ReturnType<typeof fakeCloud>;
  let stdout: string[];

  beforeEach(() => {
    // A home of its own: never the developer's real sign-in.
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'concord-linked-home-')));
    vi.stubEnv('CONCORD_REPO_ROOT', mkdtempSync(join(tmpdir(), 'concord-linked-repo-')));
    // The drain's own identity, whichever harness session runs the tests.
    vi.stubEnv('CONCORD_AGENT_ID', AGENT);
    writeCredentials(process.env, { apiUrl: 'https://api.example.test', apiKey: 'test-only' });
    ensureMachineKey(process.env, () => 'machine-1');
    cloud = fakeCloud([
      ['POST /v1/machines', () => ok({ machine: { id: 'm-uuid' } })],
      ['POST /v1/agents', () => ok({ agent: { id: 'a-uuid' } })],
      ['PUT /v1/agents/a-uuid/endpoint', () => ok({ endpoint: {} })],
      [
        'POST /v1/messages/drain',
        () =>
          ok({
            messages: [
              {
                id: 'msg-1',
                senderAgentKey: 'codex:bbbb2222',
                taskKey: null,
                replyToMessageId: null,
                content: 'stop, I am editing that file',
                createdAt: new Date().toISOString(),
                deliveredAt: new Date().toISOString(),
              },
            ],
          }),
      ],
    ]);
    vi.stubGlobal('fetch', cloud.fetch);
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function drain(format: string): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerInboxCommand(program);
    await program.parseAsync([
      'node',
      'concord',
      'inbox',
      'drain',
      '--agent',
      AGENT,
      '--format',
      format,
    ]);
  }

  it('prints nothing and never asks the cloud, so the picker opens at once', async () => {
    await drain('pre-tool-use');

    expect(stdout).toEqual([]);
    expect(cloud.requests).toEqual([]);
  });

  it('still drains through the cloud for every other format', async () => {
    await drain('json');

    expect(cloud.requests.map((request) => `${request.method} ${request.path}`)).toContain(
      'POST /v1/messages/drain',
    );
    expect(stdout.join('')).toContain('stop, I am editing that file');
  });
});
