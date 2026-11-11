import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { load } from 'js-yaml';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';

import {
  gooseConfigInstalled,
  gooseConfigPath,
  installGooseMcpConfig,
  uninstallGooseConfig,
} from '../../src/install/goose-config.js';

const temporaryHomes: string[] = [];
afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'concord-goose-test-'));
  temporaryHomes.push(home);
  const env = { HOME: home };
  const path = gooseConfigPath(env);
  return { env, path };
}

function writeYaml(path: string, yaml: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml);
}

describe('Goose configuration', () => {
  it('resolves APPDATA or HOME paths without touching the real home', () => {
    const { env } = fixture();
    expect(gooseConfigPath(env)).toBe(join(env.HOME, '.config', 'goose', 'config.yaml'));
    expect(gooseConfigPath({ ...env, APPDATA: join(env.HOME, 'appdata') })).toBe(
      join(env.HOME, 'appdata', 'Block', 'goose', 'config', 'config.yaml'),
    );
  });

  it('detects missing, disabled, malformed and enabled relay entries', () => {
    const { env, path } = fixture();
    expect(gooseConfigInstalled(env)).toBe(false);
    writeYaml(path, 'extensions:\n  other:\n    enabled: true\n');
    expect(gooseConfigInstalled(env)).toBe(false);
    writeYaml(path, 'extensions:\n  concord-relay:\n    enabled: false\n');
    expect(gooseConfigInstalled(env)).toBe(false);
    writeYaml(path, 'extensions: [invalid\n');
    expect(gooseConfigInstalled(env)).toBe(false);
    writeYaml(path, 'extensions:\n  concord-relay:\n    enabled: true\n');
    expect(gooseConfigInstalled(env)).toBe(true);
  });

  it('installs a relay and removes only that entry', () => {
    const { env, path } = fixture();
    writeYaml(
      path,
      'model: user-model\nextensions:\n  other:\n    enabled: true\n    cmd: python3\n    args: [other.py]\n',
    );
    const configSchema = z.object({
      model: z.string(),
      extensions: z.record(
        z.string(),
        z.object({ enabled: z.boolean(), cmd: z.string(), args: z.array(z.string()) }).loose(),
      ),
    });
    installGooseMcpConfig(env);
    expect(gooseConfigInstalled(env)).toBe(true);
    const installed = configSchema.parse(load(readFileSync(path, 'utf8')));
    expect(installed.model).toBe('user-model');
    expect(installed.extensions['other']).toMatchObject({
      enabled: true,
      cmd: 'python3',
      args: ['other.py'],
    });
    const relay = installed.extensions['concord-relay'];
    expect(relay).toMatchObject({ enabled: true, type: 'stdio' });
    expect(relay?.cmd).toBeTruthy();
    if (relay?.cmd === 'npx') {
      expect(relay.args).toEqual(['-y', '@concord-ai/concord-mcp']);
    } else {
      expect(relay?.cmd).toMatch(/concord-mcp$/u);
      expect(relay?.args).toEqual([]);
    }

    uninstallGooseConfig(env);
    expect(gooseConfigInstalled(env)).toBe(false);
    const remaining = readFileSync(path, 'utf8');
    expect(configSchema.parse(load(remaining))).toEqual({
      model: 'user-model',
      extensions: { other: { enabled: true, cmd: 'python3', args: ['other.py'] } },
    });
    uninstallGooseConfig(env);
    expect(readFileSync(path, 'utf8')).toBe(remaining);
  });

  it('does not create a file when uninstalling an absent config', () => {
    const { env, path } = fixture();
    uninstallGooseConfig(env);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects non-mapping extensions without overwriting them', () => {
    const { env, path } = fixture();
    const invalid = 'extensions:\n  - invalid\n';
    writeYaml(path, invalid);
    expect(() => {
      installGooseMcpConfig(env);
    }).toThrow('must be a mapping');
    expect(readFileSync(path, 'utf8')).toBe(invalid);
  });
});
