import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_SOCKET_PATH, relayAddress } from '../../src/relay/address.js';

const posix = process.platform !== 'win32';
const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function listen(path: string): Promise<void> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.close(() => {
        resolve();
      });
    });
  });
}

/** A base under a fresh /tmp directory whose socket path is exactly `bytes` long, padded with `unit`. */
function baseFor(bytes: number, unit: string): { root: string; base: string } {
  const root = mkdtempSync('/tmp/r-');
  created.push(root);
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  const tail = `/concord-relay-${user}/${'0'.repeat(24)}.sock`;
  let filler = '';
  const length = (): number => Buffer.byteLength(`${root}/${filler}${tail}`);
  while (length() + Buffer.byteLength(unit) <= bytes) filler += unit;
  while (length() < bytes) filler += 'a';
  return { root, base: join(root, filler) };
}

describe.skipIf(!posix)('relayAddress', () => {
  it('uses a private directory under the temp directory', async () => {
    const base = mkdtempSync('/tmp/r-');
    created.push(base);
    const address = relayAddress('/repo/.concord', 'codex:a', base);
    expect(address.startsWith(base)).toBe(true);
    expect(statSync(dirname(address)).mode & 0o777).toBe(0o700);
    await listen(address);
  });

  it('falls back to /tmp when an inherited temp directory makes the socket path too long', async () => {
    // Copilot CLI hands hooks `TMPDIR=/tmp/copilot-<uuid>/`; past every platform's limit here.
    const root = mkdtempSync(join(tmpdir(), 'r-'));
    created.push(root);
    const base = join(root, `copilot-${'0'.repeat(80)}`);
    mkdirSync(base);
    const address = relayAddress('/repo/.concord', 'copilot-cli:a', base);
    expect(address.startsWith(root)).toBe(false);
    expect(dirname(dirname(address))).toBe('/tmp');
    expect(Buffer.byteLength(address)).toBeLessThanOrEqual(103);
    await listen(address);
  });

  it('keeps a socket path exactly at the platform limit where it is, and listens on it', async () => {
    const { base } = baseFor(MAX_SOCKET_PATH, 'a');
    const address = relayAddress('/repo/.concord', 'codex:a', base);
    expect(Buffer.byteLength(address)).toBe(MAX_SOCKET_PATH);
    expect(address.startsWith(base)).toBe(true);
    await listen(address);
  });

  it('falls back once the path is one byte over the limit, counting bytes not characters', () => {
    // With 'é' the path is one byte over but far fewer characters than the limit.
    for (const unit of ['a', 'é']) {
      const { root, base } = baseFor(MAX_SOCKET_PATH + 1, unit);
      const address = relayAddress('/repo/.concord', 'codex:a', base);
      expect(address.startsWith(root)).toBe(false);
      expect(dirname(dirname(address))).toBe('/tmp');
    }
  });

  it('refuses a relay directory that is a symlink, leaving its target alone', () => {
    const base = mkdtempSync('/tmp/r-');
    const target = mkdtempSync('/tmp/r-target-');
    created.push(base, target);
    chmodSync(target, 0o755);
    const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
    symlinkSync(target, join(base, `concord-relay-${user}`));
    expect(() => relayAddress('/repo/.concord', 'codex:a', base)).toThrow(/does not own/u);
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it('is the same for the same workspace and agent', () => {
    const base = mkdtempSync('/tmp/r-');
    created.push(base);
    expect(relayAddress('/repo/.concord', 'codex:a', base)).toBe(
      relayAddress('/repo/.concord', 'codex:a', base),
    );
    expect(relayAddress('/repo/.concord', 'codex:a', base)).not.toBe(
      relayAddress('/repo/.concord', 'codex:b', base),
    );
  });
});
