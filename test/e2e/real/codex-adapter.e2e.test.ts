import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { availablePort } from '../../../src/cli/local-port.js';
import { CodexAppServerAdapter } from '../../../src/relay/adapters.js';
import { CodexDaemonClient } from '../../../src/relay/codex-client.js';
import { CodexReadTracker } from '../../../src/relay/codex-read-tracker.js';
import { eventually } from '../support/messages.js';
import { Sandbox } from '../support/sandbox.js';
import { SILENT } from './fake-model/brain.js';
import { FakeModel } from './fake-model/server.js';
import { hostBinaryDir, REAL_HARNESSES } from './harnesses.js';

/**
 * Codex read receipts from the adapter itself, against a real `codex
 * app-server` and the fake model: Concord sends its message id as
 * `clientUserMessageId`, and a message is read only once Codex recorded it as
 * a user item and that turn completed. In the full harness suite Codex's hook
 * transcript usually wins the race to mark a message read, so this path is
 * pinned here on its own.
 */

const codex = REAL_HARNESSES.find((harness) => harness.name === 'codex');
const binaryDir = hostBinaryDir('codex');
const required = ['all', 'codex'].some((name) =>
  (process.env['CONCORD_E2E_REAL_HARNESSES'] ?? '').split(',').includes(name),
);

async function untilReady(url: string, server: ChildProcess): Promise<void> {
  const health = `${url.replace(/^ws:/u, 'http:')}/readyz`;
  await eventually(
    async () => {
      if (server.exitCode !== null) throw new Error('codex app-server exited early');
      try {
        return (await fetch(health)).ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    'the Codex app-server to become ready',
    30_000,
  );
}

const threadStartedSchema = z.object({ thread: z.object({ id: z.string() }).loose() }).loose();

describe.skipIf((binaryDir === undefined || codex === undefined) && !required)(
  'Codex adapter read receipts (real app-server)',
  () => {
    const cleanup: (() => void | Promise<void>)[] = [];
    afterEach(async () => {
      for (const step of cleanup.reverse()) await step();
      cleanup.length = 0;
    });

    async function connect(): Promise<{
      adapter: CodexAppServerAdapter;
      client: CodexDaemonClient;
      reads: string[];
    }> {
      if (binaryDir === undefined || codex === undefined) throw new Error('codex is not installed');
      const model = await FakeModel.start();
      cleanup.push(() => model.close());
      const sandbox = Sandbox.create('real-codex-adapter', inject('concordPrefix'), {
        realHarnesses: [binaryDir],
      });
      cleanup.push(() => {
        sandbox.dispose();
      });
      // `concord setup` would normally create Codex's home; this test skips setup.
      mkdirSync(join(sandbox.home, '.codex'), { recursive: true });
      codex.configure(sandbox, model);
      const url = `ws://127.0.0.1:${String(await availablePort())}`;
      const server = spawn('codex', ['app-server', '--listen', url], {
        cwd: sandbox.repo,
        env: sandbox.env(codex.env(model)),
        stdio: 'ignore',
      });
      cleanup.push(() => {
        server.kill();
      });
      await untilReady(url, server);

      const client = new CodexDaemonClient('codex', [], url);
      const reads: string[] = [];
      // Notifications can start before the thread id (and so the tracker) exists.
      const trackers: CodexReadTracker[] = [];
      client.onNotification((notification) => {
        for (const tracker of trackers) tracker.notify(notification);
      });
      await client.connect();
      cleanup.push(() => {
        client.close();
      });
      const started = await client.request('thread/start', {
        cwd: sandbox.repo,
        approvalPolicy: 'never',
      });
      const threadId = threadStartedSchema.parse(started).thread.id;
      const tracker = new CodexReadTracker(threadId, (ids) => {
        reads.push(...ids);
      });
      trackers.push(tracker);
      const adapter = new CodexAppServerAdapter(
        client,
        threadId,
        () => client.currentTurnId(),
        tracker,
      );
      return { adapter, client, reads };
    }

    function delivery(messageId: string, body: string) {
      return {
        version: 1 as const,
        type: 'deliver' as const,
        messageId,
        senderAgentId: 'probe:e2e',
        recipientAgentId: 'codex:e2e',
        content: `[concord from probe:e2e id=${messageId}]\n${body}`,
      };
    }

    it('reads an injected message once the turn it started completes', async () => {
      const { adapter, reads } = await connect();
      const turnId = await adapter.inject(delivery('msg-inject', `${SILENT}idle`));
      expect(turnId).toBeTypeOf('string');

      await eventually(
        () => (reads.includes('msg-inject') ? true : undefined),
        'the injected message to be read',
        60_000,
      );
    }, 120_000);

    it('reads a steered message once the busy turn it joined completes', async () => {
      const { adapter, client, reads } = await connect();
      // Keep the turn busy, then steer a Concord message into it.
      await adapter.inject(delivery('msg-busy', 'run sleep 6'));
      await eventually(
        () => (client.currentTurnId() !== undefined ? true : undefined),
        'the busy turn to start',
        30_000,
      );
      await adapter.steer(delivery('msg-steer', `${SILENT}busy`));
      expect(reads).not.toContain('msg-steer');

      await eventually(
        () => (reads.includes('msg-steer') ? true : undefined),
        'the steered message to be read',
        90_000,
      );
    }, 150_000);
  },
);
