import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { spawnCommand, stopCommand } from '../../src/install/spawn-command.js';

it.skipIf(process.platform !== 'win32')('stops the child behind a Windows batch shim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'concord managed spawn '));
  const pidFile = join(dir, 'child.pid');
  const script = join(dir, 'server.cjs');
  const shim = join(dir, 'server.cmd');
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
  );
  writeFileSync(shim, `@"${process.execPath}" "${script}"\r\n`);
  const server = spawnCommand(shim, [], { env: process.env, stdio: 'ignore' });
  let stopped = false;
  try {
    await vi.waitFor(() => {
      expect(Number(readFileSync(pidFile, 'utf8'))).toBeGreaterThan(0);
    });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    stopCommand(server, process.env);
    stopped = true;
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  } finally {
    if (!stopped) stopCommand(server, process.env);
    rmSync(dir, { recursive: true, force: true });
  }
});
