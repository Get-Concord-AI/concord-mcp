import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ANTIGRAVITY_HOOKS,
  globalAntigravityHooksPath,
  hasAntigravityHooks,
  HooksConfigParseError,
  installAntigravityHooks,
  installGlobalAntigravityHooks,
  removeAntigravityHooks,
  uninstallGlobalAntigravityHooks,
  upsertAntigravityHooks,
} from '../../src/install/antigravity-hooks.js';

const hooksConfigSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

describe('antigravity hooks', () => {
  it('upserts concord hooks into an empty config', () => {
    const output = upsertAntigravityHooks(undefined);
    const parsed = hooksConfigSchema.parse(JSON.parse(output));
    expect(parsed['concord']).toBeDefined();
    expect(parsed['concord']?.['SessionStart']).toEqual(ANTIGRAVITY_HOOKS.SessionStart);
    expect(parsed['concord']?.['PreInvocation']).toEqual(ANTIGRAVITY_HOOKS.PreInvocation);
    expect(parsed['concord']?.['Stop']).toEqual(ANTIGRAVITY_HOOKS.Stop);
    expect(hasAntigravityHooks(output)).toBe(true);
  });

  it('preserves other existing hooks when upserting', () => {
    const existing = JSON.stringify({
      'lint-checker': {
        PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }],
      },
    });
    const output = upsertAntigravityHooks(existing);
    const parsed = hooksConfigSchema.parse(JSON.parse(output));
    expect(parsed['lint-checker']).toBeDefined();
    expect(parsed['concord']).toBeDefined();
  });

  it('removes concord hooks while leaving other hooks intact', () => {
    const existing = JSON.stringify({
      concord: ANTIGRAVITY_HOOKS,
      'other-hook': {
        Stop: [{ command: './other.sh' }],
      },
    });
    const removed = removeAntigravityHooks(existing);
    const parsed = hooksConfigSchema.parse(JSON.parse(removed));
    expect(parsed['concord']).toBeUndefined();
    expect(parsed['other-hook']).toBeDefined();
    expect(hasAntigravityHooks(removed)).toBe(false);
  });

  it('throws HooksConfigParseError on invalid JSON', () => {
    expect(() => upsertAntigravityHooks('{ not valid json')).toThrow(HooksConfigParseError);
    expect(() => removeAntigravityHooks('{ not valid json')).toThrow(HooksConfigParseError);
    expect(hasAntigravityHooks('{ not valid json')).toBe(false);
  });

  it('installs hooks into .agents/hooks.json in a repo root', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-ag-hooks-'));
    const relPath = installAntigravityHooks(root);
    expect(relPath).toBe(join('.agents', 'hooks.json'));

    const filePath = join(root, relPath);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf8');
    expect(hasAntigravityHooks(content)).toBe(true);
  });

  it('leaves corrupted hooks.json untouched and reports the error during install', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-ag-hooks-corrupt-'));
    const relPath = join('.agents', 'hooks.json');
    const filePath = join(root, relPath);
    const broken = '{ invalid hooks json';
    installAntigravityHooks(root);
    writeFileSync(filePath, broken);

    expect(() => installAntigravityHooks(root)).toThrow(HooksConfigParseError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('manages global antigravity hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-ag-home-'));
    const env = { HOME: home, USERPROFILE: home };

    const path = installGlobalAntigravityHooks(env);
    expect(existsSync(path)).toBe(true);
    expect(hasAntigravityHooks(readFileSync(path, 'utf8'))).toBe(true);

    uninstallGlobalAntigravityHooks(env);
    expect(existsSync(path)).toBe(false);
  });

  it('leaves malformed global hooks untouched and does not throw during uninstall', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-ag-home-broken-'));
    const env = { HOME: home, USERPROFILE: home };
    const path = globalAntigravityHooksPath(env);
    mkdirSync(dirname(path), { recursive: true });
    const broken = '{ invalid hooks json';
    writeFileSync(path, broken);

    expect(() => {
      uninstallGlobalAntigravityHooks(env);
    }).not.toThrow();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(broken);
  });

  it('reports failed write to stderr during uninstall and does not crash', () => {
    if (process.getuid?.() === 0) return;
    const home = mkdtempSync(join(tmpdir(), 'concord-ag-home-fail-'));
    const env = { HOME: home, USERPROFILE: home };
    const path = globalAntigravityHooksPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        concord: ANTIGRAVITY_HOOKS,
        'other-plugin': { Stop: [] },
      }),
    );
    chmodSync(path, 0o444);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => {
        uninstallGlobalAntigravityHooks(env);
      }).not.toThrow();
      expect(stderrSpy).toHaveBeenCalled();
      const lastCall = stderrSpy.mock.calls[0]?.[0];
      expect(String(lastCall)).toContain('failed to remove Antigravity hooks');
    } finally {
      chmodSync(path, 0o666);
      stderrSpy.mockRestore();
    }
  });
});
