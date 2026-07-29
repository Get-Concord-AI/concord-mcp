import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkForUpdate,
  formatUpdateNotice,
  isNewerVersion,
} from '../../src/cli/update-notifier.js';

function cacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'concord-update-')), 'cache.json');
}

describe('isNewerVersion', () => {
  it('compares stable semantic versions', () => {
    expect(isNewerVersion('0.4.0', '0.4.1')).toBe(true);
    expect(isNewerVersion('0.4.9', '0.5.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true);
    expect(isNewerVersion('0.4.0', '0.4.0')).toBe(false);
    expect(isNewerVersion('0.5.0', '0.4.9')).toBe(false);
  });

  it('treats a stable release as newer than its prerelease', () => {
    expect(isNewerVersion('0.5.0-beta.1', '0.5.0')).toBe(true);
    expect(isNewerVersion('0.5.0', '0.5.0-beta.1')).toBe(false);
    expect(isNewerVersion('not-semver', '0.5.0')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('returns a newer registry version and caches it', async () => {
    const path = cacheFile();
    let calls = 0;
    const fetchLatest = (): Promise<string> => {
      calls += 1;
      return Promise.resolve('0.5.0');
    };

    await expect(
      checkForUpdate({
        currentVersion: '0.4.0',
        cacheFile: path,
        now: 1_000,
        fetchLatest,
      }),
    ).resolves.toBe('0.5.0');
    await expect(
      checkForUpdate({
        currentVersion: '0.4.0',
        cacheFile: path,
        now: 2_000,
        fetchLatest,
      }),
    ).resolves.toBe('0.5.0');
    expect(calls).toBe(1);
  });

  it('does not notify when the installed version is current', async () => {
    await expect(
      checkForUpdate({
        currentVersion: '0.4.0',
        cacheFile: cacheFile(),
        fetchLatest: () => Promise.resolve('0.4.0'),
      }),
    ).resolves.toBeUndefined();
  });

  it('caches a failed best-effort check to avoid repeated network delays', async () => {
    const path = cacheFile();
    let calls = 0;
    const fetchLatest = (): Promise<null> => {
      calls += 1;
      return Promise.resolve(null);
    };

    await checkForUpdate({
      currentVersion: '0.4.0',
      cacheFile: path,
      now: 1_000,
      fetchLatest,
    });
    await checkForUpdate({
      currentVersion: '0.4.0',
      cacheFile: path,
      now: 2_000,
      fetchLatest,
    });
    expect(calls).toBe(1);
  });

  it('recovers from an invalid cache file', async () => {
    const path = cacheFile();
    writeFileSync(path, 'not-json');
    await expect(
      checkForUpdate({
        currentVersion: '0.4.0',
        cacheFile: path,
        fetchLatest: () => Promise.resolve('0.4.1'),
      }),
    ).resolves.toBe('0.4.1');
  });
});

describe('formatUpdateNotice', () => {
  it('includes the versions and global npm update command', () => {
    const notice = formatUpdateNotice('0.4.0', '0.4.1');
    expect(notice).toContain('Concord 0.4.0 → 0.4.1');
    expect(notice).toContain('npm install -g @concord-ai/concord-mcp@latest');
  });
});
