import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { eventually } from './support/messages.js';
import { Sandbox } from './support/sandbox.js';

/**
 * Grok names its background tasks in free text, so the Stop hook cannot tell
 * from the payload whether Concord's monitor is running. The receiver lease the
 * watch holds decides instead: while it is live the hook stays quiet, and once
 * the watch exits the nudge comes back.
 */
describe('Grok Stop hook monitor nudge', () => {
  const agent = 'grok:0e2e5701';
  const stopPayload = JSON.stringify({
    reason: 'end_turn',
    backgroundTasks: [
      { type: 'monitor', status: 'running', description: '[monitor] Concord inbox' },
    ],
  });
  let sandbox: Sandbox;
  let watch: ChildProcess | undefined;

  const stopHook = async (): Promise<string> => {
    const result = await sandbox.concord(
      ['inbox', 'drain', '--agent', agent, '--provider', 'grok', '--format', 'stop'],
      { input: stopPayload },
    );
    expect(result.status).toBe(0);
    return result.stdout;
  };

  beforeAll(async () => {
    sandbox = Sandbox.create('grok-stop', inject('concordPrefix'));
    const setup = await sandbox.concord(['setup', '--no-mcp', '--no-adapters'], {
      timeoutMs: 60_000,
    });
    expect(setup.status).toBe(0);
  });

  afterEach(async () => {
    if (watch?.exitCode === null) {
      watch.kill('SIGTERM');
      await once(watch, 'exit');
    }
    watch = undefined;
  });

  afterAll(() => {
    sandbox.dispose();
  });

  it('nudges when no receiver is watching', async () => {
    expect(await stopHook()).toMatch(/not watching for messages/u);
  });

  it('stays quiet while a watch holds the receiver lease, and nudges again once it exits', async () => {
    const running = spawn('concord', ['inbox', 'watch', '--agent', agent, '--provider', 'grok'], {
      cwd: sandbox.repo,
      env: sandbox.env(),
      stdio: 'ignore',
    });
    watch = running;
    await eventually(
      async () => ((await stopHook()) === '' ? true : undefined),
      'the Stop hook to see the live receiver',
    );

    running.kill('SIGTERM');
    await once(running, 'exit');
    expect(await stopHook()).toMatch(/not watching for messages/u);
  });
});
