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

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  clineDetected,
  clineDocumentsDir,
  clineGlobalHookDirs,
  clineGlobalRulesDir,
  clineHome,
  clineHookFileNames,
  clineHooksPresent,
  clineMcpSettingsPath,
  installClineUserConfigs,
  uninstallClineUserConfigs,
} from '../../src/install/cline-config.js';
import { hasMcpServer, upsertMcpServer } from '../../src/install/mcp-config.js';

const mcpConfig = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});

function fakeHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), 'concord-cline-home-'));
  return { home, env: { HOME: home, USERPROFILE: home } };
}

function readMcp(path: string): z.infer<typeof mcpConfig> {
  return mcpConfig.parse(JSON.parse(readFileSync(path, 'utf8')));
}

describe('Cline paths', () => {
  it('honours CLINE_DIR, CLINE_DATA_DIR, and CLINE_MCP_SETTINGS_PATH', () => {
    const { home, env } = fakeHome();
    expect(clineHome(env)).toBe(join(home, '.cline'));
    expect(clineMcpSettingsPath(env)).toBe(
      join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
    );

    const custom = { ...env, CLINE_DIR: join(home, 'custom-cline') };
    expect(clineHome(custom)).toBe(join(home, 'custom-cline'));
    expect(clineMcpSettingsPath(custom)).toBe(
      join(home, 'custom-cline', 'data', 'settings', 'cline_mcp_settings.json'),
    );

    const data = { ...env, CLINE_DATA_DIR: join(home, 'elsewhere') };
    expect(clineMcpSettingsPath(data)).toBe(
      join(home, 'elsewhere', 'settings', 'cline_mcp_settings.json'),
    );

    const file = { ...env, CLINE_MCP_SETTINGS_PATH: join(home, 'mcp.json') };
    expect(clineMcpSettingsPath(file)).toBe(join(home, 'mcp.json'));
  });

  it('resolves the global rules and hook directories under the Cline home', () => {
    const { home, env } = fakeHome();
    expect(clineGlobalRulesDir(env)).toBe(join(home, '.cline', 'rules'));
    expect(clineGlobalHookDirs(env)).toEqual([
      join(clineDocumentsDir(env), 'Hooks'),
      join(home, '.cline', 'hooks'),
    ]);
  });
});

describe('Cline detection', () => {
  it('detects the CLI on PATH, the home directory, and the Documents directory', () => {
    const { env } = fakeHome();
    expect(clineDetected(env)).toBe(false);

    mkdirSync(clineHome(env), { recursive: true });
    expect(clineDetected(env)).toBe(true);
  });

  it('detects an extension-only install through ~/Documents/Cline', () => {
    const { env } = fakeHome();
    mkdirSync(clineDocumentsDir(env), { recursive: true });
    expect(clineDetected(env)).toBe(true);
  });
});

describe('Cline user configs', () => {
  it('writes the MCP entry with the cline agent kind and platform hook files', () => {
    const { env } = fakeHome();
    const written = installClineUserConfigs(env);

    const mcpPath = clineMcpSettingsPath(env);
    expect(written).toContain(mcpPath);
    const config = readMcp(mcpPath);
    expect(config.mcpServers['concord']).toMatchObject({
      command: 'concord-mcp',
      env: { CONCORD_AGENT_KIND: 'cline' },
    });

    for (const dir of clineGlobalHookDirs(env)) {
      for (const name of clineHookFileNames()) {
        const path = join(dir, name);
        expect(written).toContain(path);
        const content = readFileSync(path, 'utf8');
        expect(content).toContain('concord:cline-hook');
        expect(content).toContain('concord hook cline-');
      }
    }
  });

  it('is idempotent and preserves unrelated servers and settings', () => {
    const { env } = fakeHome();
    const mcpPath = clineMcpSettingsPath(env);
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(
      mcpPath,
      `${JSON.stringify(
        {
          mcpServers: { other: { command: 'other-server', env: { TOKEN: 'x' } } },
          telemetry: { enabled: false },
        },
        null,
        2,
      )}\n`,
    );

    installClineUserConfigs(env);
    const once = readFileSync(mcpPath, 'utf8');
    installClineUserConfigs(env);
    expect(readFileSync(mcpPath, 'utf8')).toBe(once);

    const config = readMcp(mcpPath);
    expect(config.mcpServers['other']).toMatchObject({ command: 'other-server' });
    expect(config.mcpServers['concord']).toBeDefined();
    expect(hasMcpServer(once)).toBe(true);
  });

  it('does not duplicate hook files on rerun', () => {
    const { env } = fakeHome();
    installClineUserConfigs(env);
    const dir = clineGlobalHookDirs(env)[0];
    expect(dir).toBeDefined();
    if (dir === undefined) return;
    const name = clineHookFileNames()[0];
    expect(name).toBeDefined();
    if (name === undefined) return;
    const path = join(dir, name);
    const first = readFileSync(path, 'utf8');
    installClineUserConfigs(env);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(clineHooksPresent(dir)).toBe('present');
  });

  it('preserves a user-authored concord entry and a user-owned hook file', () => {
    const { env } = fakeHome();
    const mcpPath = clineMcpSettingsPath(env);
    mkdirSync(dirname(mcpPath), { recursive: true });
    const custom = {
      mcpServers: {
        concord: { command: 'my-wrapper', args: ['--custom'] },
        other: { command: 'other-server' },
      },
    };
    writeFileSync(mcpPath, `${JSON.stringify(custom, null, 2)}\n`);

    const hookDir = clineGlobalHookDirs(env)[0];
    expect(hookDir).toBeDefined();
    if (hookDir === undefined) return;
    mkdirSync(hookDir, { recursive: true });
    const hookName = clineHookFileNames()[0];
    expect(hookName).toBeDefined();
    if (hookName === undefined) return;
    const userHook = join(hookDir, hookName);
    writeFileSync(userHook, '#!/bin/sh\necho user-hook\n');
    if (process.platform !== 'win32') chmodSync(userHook, 0o755);

    installClineUserConfigs(env);
    expect(JSON.parse(readFileSync(mcpPath, 'utf8'))).toEqual(custom);
    expect(readFileSync(userHook, 'utf8')).toBe('#!/bin/sh\necho user-hook\n');
    // The secondary hook directory still got Concord's copy.
    const secondary = clineGlobalHookDirs(env)[1];
    expect(secondary).toBeDefined();
    if (secondary !== undefined) {
      expect(clineHooksPresent(secondary)).toBe('present');
    }
  });

  it('uninstall removes only Concord-owned entries and hook files', () => {
    const { env } = fakeHome();
    installClineUserConfigs(env);
    uninstallClineUserConfigs(env);

    const config = readMcp(clineMcpSettingsPath(env));
    expect(config.mcpServers).not.toHaveProperty('concord');
    for (const dir of clineGlobalHookDirs(env)) {
      for (const name of clineHookFileNames()) {
        expect(existsSync(join(dir, name))).toBe(false);
      }
    }
  });
});

describe('Cline MCP config helpers', () => {
  it('upsertMcpServer output round-trips through hasMcpServer', () => {
    const written = upsertMcpServer(undefined, undefined, { CONCORD_AGENT_KIND: 'cline' });
    expect(hasMcpServer(written)).toBe(true);
    expect(hasMcpServer('{ not json')).toBe(false);
    expect(() => upsertMcpServer('{ not json')).toThrow();
  });

  it('reports partial hook coverage when a same-named user file blocks one hook', () => {
    const { env } = fakeHome();
    installClineUserConfigs(env);
    const dir = clineGlobalHookDirs(env)[0];
    expect(dir).toBeDefined();
    if (dir === undefined) return;
    const first = clineHookFileNames()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    writeFileSync(join(dir, first), '#!/bin/sh\necho mine\n');
    expect(clineHooksPresent(dir)).toBe('partial');
  });
});
