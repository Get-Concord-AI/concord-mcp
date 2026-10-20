import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hermesConfigInstalled,
  hermesConfigPath,
  installHermesMcpConfig,
  uninstallHermesMcpConfig,
} from '../../src/install/hermes-config.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'concord-hermes-test-'));
  const env = { HOME: home };
  return { env, path: hermesConfigPath(env) };
}

function seed(path: string, yaml: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml);
}

describe('Hermes MCP config', () => {
  it('uses the Hermes home override', () => {
    const { env } = fixture();
    expect(hermesConfigPath(env)).toBe(join(env.HOME, '.hermes', 'config.yaml'));
    expect(hermesConfigPath({ ...env, HERMES_HOME: join(env.HOME, 'custom') })).toBe(
      join(env.HOME, 'custom', 'config.yaml'),
    );
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

  it('does not create config when uninstalling a missing installation', () => {
    const { env, path } = fixture();
    uninstallHermesMcpConfig(env);
    expect(existsSync(path)).toBe(false);
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
