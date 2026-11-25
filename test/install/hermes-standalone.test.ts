import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { standaloneInstall } from '../../src/config/install-mode.js';
import {
  hermesConfigInstalled,
  hermesConfigPath,
  installHermesMcpConfig,
  uninstallHermesMcpConfig,
} from '../../src/install/hermes-config.js';

vi.mock('../../src/config/install-mode.js', () => ({ standaloneInstall: vi.fn() }));

const installedConfigSchema = z.object({
  model: z.string().optional(),
  mcp_servers: z.object({
    concord: z.object({
      command: z.string(),
      args: z.array(z.string()),
      enabled: z.boolean(),
    }),
  }),
});

const homes: string[] = [];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'concord-hermes-launch-'));
  homes.push(home);
  const env = { HOME: home };
  return { env, home, path: hermesConfigPath(env) };
}

function installedEntry(path: string) {
  const parsed: unknown = load(readFileSync(path, 'utf8'));
  return installedConfigSchema.parse(parsed).mcp_servers.concord;
}

beforeEach(() => {
  vi.mocked(standaloneInstall).mockReturnValue(undefined);
});

afterEach(() => {
  vi.mocked(standaloneInstall).mockReset();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('Hermes server launcher for npm and standalone installs', () => {
  it('uses npx for an npm package and detects the matching entry', () => {
    const { env, path } = fixture();
    installHermesMcpConfig(env);
    expect(installedEntry(path)).toEqual({
      command: 'npx',
      args: ['-y', '@concord-ai/concord-mcp'],
      enabled: true,
    });
    expect(hermesConfigInstalled(env)).toBe(true);
  });

  it('uses the standalone binary without npx and preserves unrelated settings', () => {
    const { env, home, path } = fixture();
    const binDir = join(home, 'standalone binaries');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'model: original\nmcp_servers:\n  other:\n    command: python\n');
    vi.mocked(standaloneInstall).mockReturnValue({
      binDir,
      installDir: join(home, 'standalone'),
    });
    installHermesMcpConfig(env);
    expect(installedEntry(path)).toEqual({
      command: join(binDir, 'concord-mcp'),
      args: [],
      enabled: true,
    });
    expect(hermesConfigInstalled(env)).toBe(true);
    const installed = readFileSync(path, 'utf8');
    expect(installed).toContain('model: original');
    expect(installed).toContain('other:');
    uninstallHermesMcpConfig(env);
    expect(hermesConfigInstalled(env)).toBe(false);
    const restored = readFileSync(path, 'utf8');
    expect(restored).toContain('model: original');
    expect(restored).toContain('other:');
    expect(restored).not.toContain('concord:');
  });

  it('detects a stale npx entry after switching to standalone, then repairs it', () => {
    const { env, home, path } = fixture();
    installHermesMcpConfig(env);
    vi.mocked(standaloneInstall).mockReturnValue({
      binDir: join(home, 'bin'),
      installDir: join(home, 'install'),
    });

    expect(hermesConfigInstalled(env)).toBe(false);
    installHermesMcpConfig(env);
    expect(installedEntry(path).command).toBe(join(home, 'bin', 'concord-mcp'));
    expect(hermesConfigInstalled(env)).toBe(true);
  });

  it('rejects a different binary or unexpected arguments for standalone', () => {
    const { env, home, path } = fixture();
    vi.mocked(standaloneInstall).mockReturnValue({
      binDir: join(home, 'bin'),
      installDir: join(home, 'install'),
    });
    installHermesMcpConfig(env);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('concord-mcp', 'wrong-launcher'));
    expect(hermesConfigInstalled(env)).toBe(false);

    writeFileSync(path, original.replace('args: []', 'args: [unwanted]'));
    expect(hermesConfigInstalled(env)).toBe(false);
  });
});
