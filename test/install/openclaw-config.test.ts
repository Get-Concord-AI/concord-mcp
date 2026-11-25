import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  installOpenclawMcpConfig,
  openclawConfigInstalled,
  openclawConfigPath,
  openclawStateDir,
  uninstallOpenclawConfig,
} from '../../src/install/openclaw-config.js';

const temporaryHomes: string[] = [];
afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'concord-openclaw-test-'));
  temporaryHomes.push(home);
  const env = { HOME: home };
  const path = openclawConfigPath(env);
  return { env, path, home };
}

function writeConfig(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const read = (path: string): string => readFileSync(path, 'utf8');

describe('OpenClaw configuration', () => {
  it('resolves the state directory and config path from HOME or OpenClaw overrides', () => {
    const { env, home } = fixture();
    expect(openclawStateDir(env)).toBe(join(home, '.openclaw'));
    expect(openclawConfigPath(env)).toBe(join(home, '.openclaw', 'openclaw.json'));
    const profileHome = join(home, 'profile-home');
    expect(
      openclawConfigPath({ ...env, OPENCLAW_HOME: profileHome, OPENCLAW_PROFILE: 'dev' }),
    ).toBe(join(profileHome, '.openclaw-dev', 'openclaw.json'));
    expect(openclawStateDir({ ...env, OPENCLAW_STATE_DIR: '~/state' })).toBe(join(home, 'state'));
    expect(openclawConfigPath({ ...env, OPENCLAW_STATE_DIR: join(home, 'state') })).toBe(
      join(home, 'state', 'openclaw.json'),
    );
    expect(openclawConfigPath({ ...env, OPENCLAW_CONFIG_PATH: join(home, 'c.json5') })).toBe(
      join(home, 'c.json5'),
    );
  });

  it('detects missing, disabled, malformed and enabled entries', () => {
    const { env, path } = fixture();
    expect(openclawConfigInstalled(env)).toBe(false);
    writeConfig(path, '{ mcp: { servers: { other: { command: "x" } } } }');
    expect(openclawConfigInstalled(env)).toBe(false);
    writeConfig(path, '{ mcp: { servers: { concord: { command: "npx", enabled: false } } } }');
    expect(openclawConfigInstalled(env)).toBe(false);
    writeConfig(path, '{ mcp: { servers: [');
    expect(openclawConfigInstalled(env)).toBe(false);
    writeConfig(path, '{ mcp: { servers: { concord: { command: "npx" } } } }');
    expect(openclawConfigInstalled(env)).toBe(true);
  });

  it('merges into an existing JSON5 config and removes only its own entry', () => {
    const { env, path } = fixture();
    writeConfig(
      path,
      `{
  // the gateway port
  gateway: { port: 18789 },
  mcp: { servers: { other: { command: "python3", args: ["other.py"] } } },
}
`,
    );

    installOpenclawMcpConfig(env);

    const installed: unknown = JSON.parse(read(path));
    expect(installed).toMatchObject({
      gateway: { port: 18789 },
      mcp: {
        servers: {
          other: { command: 'python3', args: ['other.py'] },
          concord: {
            command: 'npx',
            args: ['-y', '@concord-ai/concord-mcp'],
            env: { CONCORD_AGENT_KIND: 'openclaw' },
            enabled: true,
          },
        },
      },
    });
    expect(openclawConfigInstalled(env)).toBe(true);

    installOpenclawMcpConfig(env);
    expect(read(path).match(/"concord"/gu)).toHaveLength(1);

    uninstallOpenclawConfig(env);
    expect(JSON.parse(read(path))).toEqual({
      gateway: { port: 18789 },
      mcp: { servers: { other: { command: 'python3', args: ['other.py'] } } },
    });
    expect(openclawConfigInstalled(env)).toBe(false);
  });

  it('creates the config when OpenClaw has none yet', () => {
    const { env, path } = fixture();
    installOpenclawMcpConfig(env);
    expect(JSON.parse(read(path))).toMatchObject({
      mcp: { servers: { concord: { command: 'npx' } } },
    });
  });

  it('leaves a user-owned concord entry alone on install and uninstall', () => {
    const { env, path } = fixture();
    const own = '{ mcp: { servers: { concord: { command: "/opt/mine/server", args: [] } } } }\n';
    writeConfig(path, own);
    installOpenclawMcpConfig(env);
    expect(read(path)).toBe(own);
    uninstallOpenclawConfig(env);
    expect(read(path)).toBe(own);
  });

  it("treats a standalone launcher entry with custom arguments or environment as the user's", () => {
    const { env, path } = fixture();
    const launcher = '/home/u/.concord/bin/concord-mcp';
    for (const own of [
      `{ mcp: { servers: { concord: { command: "${launcher}", env: { CONCORD_AGENT_KIND: "openclaw", CONCORD_AGENT_ID: "openclaw:main" } } } } }\n`,
      `{ mcp: { servers: { concord: { command: "${launcher}", args: ["--verbose"] } } } }\n`,
    ]) {
      writeConfig(path, own);
      installOpenclawMcpConfig(env);
      expect(read(path)).toBe(own);
      uninstallOpenclawConfig(env);
      expect(read(path)).toBe(own);
    }
    writeConfig(
      path,
      `{ mcp: { servers: { concord: { command: "${launcher}", args: [], env: { CONCORD_AGENT_KIND: "openclaw" } } } } }`,
    );
    uninstallOpenclawConfig(env);
    expect(JSON.parse(read(path))).toEqual({ mcp: { servers: {} } });
  });

  it('refuses to overwrite a config whose mcp or servers is not a mapping', () => {
    const { env, path } = fixture();
    writeConfig(path, '{ mcp: [] }');
    expect(() => {
      installOpenclawMcpConfig(env);
    }).toThrow('OpenClaw `mcp` configuration must be a mapping.');
    expect(read(path)).toBe('{ mcp: [] }');
    writeConfig(path, '{ mcp: { servers: "none" } }');
    expect(() => {
      installOpenclawMcpConfig(env);
    }).toThrow('OpenClaw `mcp.servers` configuration must be a mapping.');
  });

  it('is a no-op to uninstall when no config exists', () => {
    const { env, path } = fixture();
    uninstallOpenclawConfig(env);
    expect(existsSync(path)).toBe(false);
  });
});

it('preserves split MCP config and a customized npx entry', () => {
  const { env, path } = fixture();
  const included = '{ mcp: { $include: "./mcp.json5" } }';
  writeConfig(path, included);
  expect(() => {
    installOpenclawMcpConfig(env);
  }).toThrow('$include');
  expect(read(path)).toBe(included);

  const own =
    '{ mcp: { servers: { concord: { command: "npx", args: ["-y", "@concord-ai/concord-mcp", "--custom"], env: { CONCORD_AGENT_KIND: "openclaw" } } } } }';
  writeConfig(path, own);
  installOpenclawMcpConfig(env);
  uninstallOpenclawConfig(env);
  expect(read(path)).toBe(own);
});
