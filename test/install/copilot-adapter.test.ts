import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  installGlobalAdapters,
  statusAdapter,
  uninstallGlobalAdapters,
} from '../../src/install/adapters/index.js';
import {
  copilotConfigFile,
  copilotConfigInstalled,
  copilotHooksFile,
} from '../../src/install/copilot-config.js';
import { writeFakeVersion } from '../helpers/fake-command.js';

// Links into this checkout count as lasting even when it lives under /tmp.
const LASTING = (): boolean => false;

function copilotEnv(version: string): { HOME: string; PATH: string; COPILOT_HOME: string } {
  const home = mkdtempSync(join(tmpdir(), 'concord-copilot-adapter-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFakeVersion(bin, 'copilot', `GitHub Copilot CLI ${version}.`);
  return { HOME: home, PATH: bin, COPILOT_HOME: join(home, '.copilot') };
}

describe('Copilot CLI adapter', () => {
  it('registers the server and lifecycle hooks when Copilot is on PATH', () => {
    const env = copilotEnv('1.0.100');
    const report = installGlobalAdapters(import.meta.url, env, undefined, LASTING);

    expect(report.find((entry) => entry.harness === 'copilot-cli')).toMatchObject({
      status: 'installed',
      capabilities: ['pull', 'inject', 'steer', 'idle', 'busy'],
    });
    expect(copilotConfigInstalled(env)).toBe(true);
    expect(existsSync(copilotHooksFile(env))).toBe(true);
  });

  it('asks for action when the hooks file is gone, since sessions cannot be identified', () => {
    const env = copilotEnv('1.0.100');
    installGlobalAdapters(import.meta.url, env, undefined, LASTING);
    rmSync(copilotHooksFile(env));

    expect(statusAdapter('copilot-cli', env)).toMatchObject({
      status: 'action_required',
      capabilities: ['pull'],
    });
  });

  it('installs nothing below the supported version', () => {
    const env = copilotEnv('0.0.400');
    const report = installGlobalAdapters(import.meta.url, env, undefined, LASTING);

    expect(report.find((entry) => entry.harness === 'copilot-cli')?.status).toBe(
      'unsupported_version',
    );
    expect(existsSync(copilotConfigFile(env))).toBe(false);
  });

  it('is not detected without the executable', () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), 'concord-no-copilot-')), PATH: '' };
    expect(statusAdapter('copilot-cli', env).status).toBe('not_detected');
  });

  it('removes the server and hooks on uninstall', () => {
    const env = copilotEnv('1.0.100');
    installGlobalAdapters(import.meta.url, env, undefined, LASTING);
    uninstallGlobalAdapters(env);

    expect(copilotConfigInstalled(env)).toBe(false);
    expect(existsSync(copilotHooksFile(env))).toBe(false);
  });
});
