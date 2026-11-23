import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, expect, it, vi } from 'vitest';

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }));

import { launchDetachedConcord } from '../../src/cli/detached-host.js';
import { spawnCommand } from '../../src/install/spawn-command.js';
import { CodexDaemonClient } from '../../src/relay/codex-client.js';
import { gitOriginRemote } from '../../src/workspaces/store.js';

beforeEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
});

it('hides the console only for command shims that opt in as background children', () => {
  const child = {};
  spawnMock.mockReturnValue(child);

  expect(
    spawnCommand(process.execPath, ['--version'], { env: process.env, windowsHide: true }),
  ).toBe(child);
  expect(spawnMock).toHaveBeenLastCalledWith(
    process.execPath,
    ['--version'],
    expect.objectContaining({ windowsHide: true, shell: false }),
  );

  spawnCommand(process.execPath, ['--version'], { env: process.env, stdio: 'inherit' });
  expect(spawnMock).toHaveBeenLastCalledWith(
    process.execPath,
    ['--version'],
    expect.not.objectContaining({ windowsHide: true }),
  );
});

it('hides the detached Concord host console while preserving its detached lifetime', () => {
  const unref = vi.fn();
  spawnMock.mockReturnValue({ unref });

  const originalEntrypoint = process.argv[1];
  process.argv[1] = 'concord.js';
  try {
    launchDetachedConcord('C:\\repo', ['adapters', 'host-codex']);
  } finally {
    if (originalEntrypoint === undefined) process.argv.splice(1, 1);
    else process.argv[1] = originalEntrypoint;
  }

  expect(spawnMock).toHaveBeenCalledWith(
    process.execPath,
    ['concord.js', '--repo', 'C:\\repo', 'adapters', 'host-codex'],
    expect.objectContaining({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }),
  );
  expect(unref).toHaveBeenCalledOnce();
});

it('hides the Codex stdio proxy console without changing its pipe contract', async () => {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  spawnMock.mockReturnValue(child);

  const client = new CodexDaemonClient('codex.exe', [], '');
  // Only the spawn options matter here; the fake child never completes the
  // proxy's WebSocket handshake, so the connection is closed once it spawns.
  const connected = client.connect().catch(() => undefined);
  await vi.waitFor(() => {
    expect(spawnMock).toHaveBeenCalled();
  });
  client.close();
  stdout.end();
  await connected;

  expect(spawnMock).toHaveBeenCalledWith(
    'codex.exe',
    [],
    expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  );
});

it('hides the Git console used for project remote discovery', () => {
  spawnSyncMock.mockReturnValue({ status: 0, stdout: 'https://example.test/repo.git\n' });

  expect(gitOriginRemote('C:\\repo')).toBe('https://example.test/repo.git');
  expect(spawnSyncMock).toHaveBeenCalledWith(
    'git',
    ['-C', 'C:\\repo', 'remote', 'get-url', 'origin'],
    expect.objectContaining({ windowsHide: true }),
  );
});
