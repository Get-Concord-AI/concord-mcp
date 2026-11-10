import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  installOpenclawMcpConfig,
  openclawAgentWorkspaces,
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

describe('OpenClaw agent workspaces', () => {
  it('defaults to the main agent in the state workspace', () => {
    const { env, home } = fixture();
    expect(openclawAgentWorkspaces(env)).toEqual([
      { agentId: 'main', workspace: join(home, '.openclaw', 'workspace') },
    ]);
    expect(openclawAgentWorkspaces({ ...env, OPENCLAW_WORKSPACE_DIR: join(home, 'w') })).toEqual([
      { agentId: 'main', workspace: join(home, 'w') },
    ]);
  });

  it('resolves each configured agent as OpenClaw does', () => {
    const { env, path, home } = fixture();
    writeConfig(
      path,
      `{
  agents: {
    entries: {
      main: { default: true },
      research: {},
      ops: { workspace: "~/ops-space" },
    },
  },
}`,
    );
    expect(openclawAgentWorkspaces(env)).toEqual([
      { agentId: 'main', workspace: join(home, '.openclaw', 'workspace') },
      { agentId: 'research', workspace: join(home, '.openclaw', 'workspace-research') },
      { agentId: 'ops', workspace: join(home, 'ops-space') },
    ]);
  });

  it('nests other agents under a shared workspace root and reads the legacy list form', () => {
    const { env, path, home } = fixture();
    writeConfig(
      path,
      `{
  agents: {
    defaults: { workspace: "~/agents" },
    list: [{ id: "writer" }, { id: "main" }],
  },
}`,
    );
    expect(openclawAgentWorkspaces(env)).toEqual([
      { agentId: 'writer', workspace: join(home, 'agents', 'writer') },
      { agentId: 'main', workspace: join(home, 'agents') },
    ]);
  });

  it('falls back to the default agent when the config is unreadable', () => {
    const { env, path, home } = fixture();
    writeConfig(path, '{ agents: [');
    expect(openclawAgentWorkspaces(env)).toEqual([
      { agentId: 'main', workspace: join(home, '.openclaw', 'workspace') },
    ]);
  });
});
