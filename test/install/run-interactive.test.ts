import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInteractive } from '../../src/install/spawn-command.js';

/** A child that exits with `code`, or fails to start with `error`, once listened to. */
function fakeChild(outcome: { code: number } | { error: Error }): EventEmitter {
  const child = new EventEmitter();
  setImmediate(() => {
    if ('error' in outcome) child.emit('error', outcome.error);
    else child.emit('close', outcome.code);
  });
  return child;
}

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args: readonly string[], options: SpawnOptions) => EventEmitter>(
    () => fakeChild({ code: 0 }),
  ),
}));
vi.mock('node:child_process', () => ({ spawn, spawnSync: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform');

function onPlatform(name: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: name });
}

describe('runInteractive', () => {
  beforeEach(() => {
    spawn.mockClear();
  });

  afterEach(() => {
    if (platform !== undefined) Object.defineProperty(process, 'platform', platform);
  });

  it("sends Windows' npm.cmd through cmd.exe, on this terminal, and returns its exit code", async () => {
    onPlatform('win32');
    spawn.mockImplementationOnce(() => fakeChild({ code: 3 }));
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };

    const code = await runInteractive(
      'npm.cmd',
      ['install', '-g', '@concord-ai/concord-mcp@latest'],
      env,
    );

    expect(code).toBe(3);
    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/v:off', '/s', '/c', '"npm.cmd install -g @concord-ai/concord-mcp@latest"'],
      { env, shell: false, stdio: 'inherit', windowsVerbatimArguments: true },
    );
  });

  it('runs anything else directly, without a shell', async () => {
    onPlatform('linux');
    await runInteractive('npm', ['install', '-g', 'x'], {});
    expect(spawn).toHaveBeenCalledWith('npm', ['install', '-g', 'x'], {
      env: {},
      shell: false,
      stdio: 'inherit',
      windowsVerbatimArguments: false,
    });
  });

  it('rejects when the command cannot start', async () => {
    onPlatform('linux');
    spawn.mockImplementationOnce(() => fakeChild({ error: new Error('ENOENT') }));
    await expect(runInteractive('missing', [], {})).rejects.toThrow('ENOENT');
  });
});
