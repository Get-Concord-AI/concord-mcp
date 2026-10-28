import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { capabilityFor, monitorCapabilityFor } from '../../src/domain/delivery.js';
import { dirname, join } from 'node:path';
import {
  installGlobalAdapters,
  statusAdapter,
  uninstallGlobalAdapters,
} from '../../src/install/adapters/index.js';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hermesConfigInstalled,
  hermesConfigPath,
  installHermesMcpConfig,
  uninstallHermesMcpConfig,
} from '../../src/install/hermes-config.js';

const temporaryHomes: string[] = [];
afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'concord-hermes-test-'));
  temporaryHomes.push(home);
  const env = { HOME: home, CODEX_HOME: join(home, '.codex') };
  return { env, path: hermesConfigPath(env) };
}

function seed(path: string, yaml: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml);
}

describe('Hermes MCP config', () => {
  it('detects and installs the Hermes adapter through global setup', () => {
    const { env, path } = fixture();
    const bin = join(env.HOME, 'bin');
    mkdirSync(bin);
    const hermes = join(bin, 'hermes');
    writeFileSync(hermes, '#!/bin/sh\necho hermes\n');
    chmodSync(hermes, 0o755);
    const runtimeEnv = { ...env, PATH: bin };
    expect(statusAdapter('hermes', runtimeEnv).status).toBe('action_required');
    installGlobalAdapters(import.meta.url, runtimeEnv);
    expect(statusAdapter('hermes', runtimeEnv)).toMatchObject({
      status: 'installed',
      capabilities: [],
    });
    expect(statusAdapter('hermes', runtimeEnv).detail).toContain(
      'peer-message delivery is not yet supported',
    );
    expect(capabilityFor('hermes')).toEqual({
      transport: 'pull',
      reach: [],
      operations: [],
    });
    expect(monitorCapabilityFor('hermes')).toEqual({
      transport: 'pull',
      reach: [],
      operations: [],
    });
    expect(existsSync(path)).toBe(true);
    uninstallGlobalAdapters(runtimeEnv);
    expect(statusAdapter('hermes', runtimeEnv).status).toBe('action_required');
  });

  it('uses the Hermes home override', () => {
    const { env } = fixture();
    expect(hermesConfigPath(env)).toBe(join(env.HOME, '.hermes', 'config.yaml'));
    expect(hermesConfigPath({ ...env, HERMES_HOME: join(env.HOME, 'custom') })).toBe(
      join(env.HOME, 'custom', 'config.yaml'),
    );
  });

  it('treats empty Hermes home overrides as absent', () => {
    const { env, path } = fixture();
    expect(hermesConfigPath({ ...env, HERMES_HOME: '' })).toBe(path);
    expect(hermesConfigPath({ ...env, HERMES_HOME: '   ' })).toBe(path);
  });

  it('preserves a symlinked config when installing and uninstalling', () => {
    const { env, path } = fixture();
    const target = join(env.HOME, 'shared.yaml');
    seed(target, 'model: original\n');
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    installHermesMcpConfig(env);
    expect(readFileSync(target, 'utf8')).toContain('@concord-ai/concord-mcp');
    uninstallHermesMcpConfig(env);
    expect(readFileSync(target, 'utf8')).toContain('model: original');
    expect(readFileSync(path, 'utf8')).toBe(readFileSync(target, 'utf8'));
  });

  it('installs, detects, and uninstalls without removing other servers or settings', () => {
    const { env, path } = fixture();
    seed(path, 'model: test\nmcp_servers:\n  other:\n    command: python\n');
    expect(hermesConfigInstalled(env)).toBe(false);
    installHermesMcpConfig(env);
    expect(hermesConfigInstalled(env)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('@concord-ai/concord-mcp');
    uninstallHermesMcpConfig(env);
    expect(hermesConfigInstalled(env)).toBe(false);
    const remaining = readFileSync(path, 'utf8');
    expect(remaining).toContain('other:');
    expect(remaining).toContain('model: test');
    uninstallHermesMcpConfig(env);
    expect(readFileSync(path, 'utf8')).toBe(remaining);
  });

  it('writes private settings atomically without leaving temporary files', () => {
    const { env, path } = fixture();
    seed(path, 'model: original\n');
    chmodSync(path, 0o644);

    installHermesMcpConfig(env);
    // Windows does not expose POSIX mode bits through statSync; check 0600 on POSIX.
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(dirname(path))).toEqual(['config.yaml']);
    expect(readFileSync(path, 'utf8')).toContain('model: original');

    uninstallHermesMcpConfig(env);
    expect(readdirSync(dirname(path))).toEqual(['config.yaml']);
    expect(readFileSync(path, 'utf8')).toContain('model: original');
  });

  it('rejects a different npx package as installed', () => {
    const { env, path } = fixture();
    seed(path, 'mcp_servers:\n  concord:\n    command: npx\n    args: [other-package]\n');
    expect(hermesConfigInstalled(env)).toBe(false);
  });

  it('does not create config when uninstalling a missing installation', () => {
    const { env, path } = fixture();
    uninstallHermesMcpConfig(env);
    expect(existsSync(path)).toBe(false);
  });

  it('continues global cleanup when Hermes YAML is malformed', () => {
    const { env, path } = fixture();
    const original = 'mcp_servers: [invalid\n';
    seed(path, original);
    expect(() => uninstallGlobalAdapters(env)).not.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('rejects invalid server maps without overwriting existing config', () => {
    const { env, path } = fixture();
    const original = 'mcp_servers:\n  - bad\n';
    seed(path, original);
    expect(() => {
      installHermesMcpConfig(env);
    }).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});
