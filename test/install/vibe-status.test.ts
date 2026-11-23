import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  executablePath,
  installGlobalAdapters,
  statusGlobalAdapters,
} from '../../src/install/adapters/index.js';
import { statusVibe } from '../../src/install/adapters/vibe.js';
import { vibeMcpConfigPath, vibeMcpInstalled } from '../../src/install/vibe-config.js';
import { vibeHooksPresent } from '../../src/install/vibe-hooks.js';
import { vibeHooksPath } from '../../src/install/vibe-config.js';
import { writeFakeVersion } from '../helpers/fake-command.js';

const LASTING = () => false;

describe('statusVibe', () => {
  it('reports not_detected without touching the config when Vibe is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-vibe-status-'));
    // A folder where hooks.toml should be would throw if it were read.
    const report = statusVibe(undefined, { HOME: home, VIBE_HOME: join(home, '.vibe') });
    expect(report.status).toBe('not_detected');
    expect(report.harness).toBe('vibe');
    expect(report.monitor).toBe('harness-monitor');
  });

  it('reports unsupported_version below the verified baseline', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-vibe-status-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFakeVersion(bin, 'vibe', 'vibe 3.0.9');
    const env = { HOME: home, PATH: bin };
    const report = statusVibe(executablePath('vibe', env), env);
    expect(report.status).toBe('unsupported_version');
  });

  it('reports action_required when Vibe is present but Concord is not installed', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-vibe-status-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFakeVersion(bin, 'vibe', 'vibe 3.1.3');
    const env = { HOME: home, PATH: bin };
    const report = statusVibe(executablePath('vibe', env), env);
    expect(report.status).toBe('action_required');
    expect(report.capabilities).toEqual([]);
  });
});

describe('installGlobalAdapters with Vibe', () => {
  it('writes config.toml and hooks.toml for a supported Vibe and reports installed', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-vibe-install-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFakeVersion(bin, 'vibe', 'vibe 3.1.3');
    const env = { HOME: home, PATH: bin };

    const report = installGlobalAdapters(import.meta.url, env, undefined, LASTING);

    expect(report.find((entry) => entry.harness === 'vibe')).toMatchObject({
      detected: true,
      status: 'installed',
      capabilities: ['pull', 'busy'],
    });
    const mcp = readFileSync(vibeMcpConfigPath(env), 'utf8');
    expect(mcp).toContain('name = "concord"');
    expect(mcp).toContain('command = "concord-mcp"');
    const hooks = readFileSync(vibeHooksPath(env), 'utf8');
    expect(hooks).toContain('concord hook vibe-session-start');
    expect(hooks).toContain('inbox drain --from-hook --provider vibe --format vibe');
    expect(vibeMcpInstalled(env)).toBe(true);
    expect(vibeHooksPresent(env)).toBe(true);
  });

  it('skips installation for an unsupported Vibe version', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-vibe-install-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFakeVersion(bin, 'vibe', 'vibe 3.0.9');
    const env = { HOME: home, PATH: bin };

    installGlobalAdapters(import.meta.url, env, undefined, LASTING);

    expect(existsSync(vibeMcpConfigPath(env))).toBe(false);
    expect(existsSync(vibeHooksPath(env))).toBe(false);
    expect(statusGlobalAdapters(env).find((entry) => entry.harness === 'vibe')?.status).toBe(
      'unsupported_version',
    );
  });
});
