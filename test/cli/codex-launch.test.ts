import { ChildProcess } from 'node:child_process';
import * as childProcess from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { launchCodex } from '../../src/cli/commands/adapters.js';
import * as adapters from '../../src/install/adapters/index.js';
import { batchCommandLine } from '../../src/install/spawn-command.js';
import * as localPort from '../../src/cli/local-port.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('managed Codex executable (#326)', () => {
  it.each([
    ['win32', 'C:\\Program Files\\codex.cmd', true],
    ['win32', 'C:\\Tools\\codex.BAT', true],
    ['win32', 'C:\\Tools\\codex.exe', false],
    ['darwin', '/opt/tools/codex', false],
  ] as const)('launches %s executable %s', async (platform, executable, batch) => {
    vi.stubGlobal('process', {
      ...process,
      platform,
      env: { ...process.env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
    vi.spyOn(adapters, 'executablePath').mockReturnValue(executable);
    vi.spyOn(localPort, 'availablePort').mockResolvedValue(43210);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    const server = new ChildProcess();
    const tui = new ChildProcess();
    const kill = vi.spyOn(server, 'kill').mockReturnValue(true);
    const spawn = vi
      .mocked(childProcess.spawn)
      .mockReturnValueOnce(server)
      .mockImplementationOnce(() => {
        queueMicrotask(() => tui.emit('exit', 0));
        return tui;
      });
    const args = ['-c', 'model="a b"', 'prompt & more'];
    await launchCodex(args, '/repo with spaces');

    const url = 'ws://127.0.0.1:43210';
    const expectedArgs = [
      ['app-server', '--listen', url, '-c', 'model="a b"'],
      ['--remote', url, ...args],
    ];
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const [index, argv] of expectedArgs.entries()) {
      const call = spawn.mock.calls[index];
      expect(call?.[0]).toBe(batch ? process.env['ComSpec'] : executable);
      expect(call?.[1]).toEqual(
        batch ? ['/d', '/v:off', '/s', '/c', batchCommandLine(executable, argv)] : argv,
      );
      expect(call?.[2]).toMatchObject({
        cwd: '/repo with spaces',
        env: { CONCORD_CODEX_APP_SERVER_URL: url },
        stdio: index === 0 ? ['ignore', 'ignore', 'inherit'] : 'inherit',
        shell: false,
        windowsVerbatimArguments: batch,
      });
    }
    expect(kill).toHaveBeenCalledOnce();
  });
});
