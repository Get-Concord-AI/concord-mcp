import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { relayAddress } from '../../src/relay/address.js';

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
