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
  clineEntryIsManaged,
  clineExtensionDetected,
  clineGlobalHookDirs,
  clineGlobalRulesDir,
  clineGlobalRulesDirs,
  clineGlobalRulesInstallPaths,
  clineGlobalRulesPaths,
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
  return {
    home,
    env: { HOME: home, USERPROFILE: home, CONCORD_DOCUMENTS_DIR: join(home, 'Documents') },
  };
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
    // The Documents override equals ~/Documents here, so the hook dirs
    // deduplicate to the extension-facing one plus the SDK home fallback.
    expect(clineGlobalHookDirs(env)).toEqual([
      join(home, 'Documents', 'Cline', 'Hooks'),
      join(home, '.cline', 'hooks'),
    ]);
  });

  it('chooses one rules install target, preferring the first existing directory', () => {
    const { home, env } = fakeHome();
    expect(clineGlobalRulesInstallPaths(env)).toEqual([
      join(home, '.cline', 'rules', 'concord.md'),
    ]);

    const documentsRules = join(home, 'Documents', 'Cline', 'Rules');
    mkdirSync(documentsRules, { recursive: true });
    expect(clineGlobalRulesInstallPaths(env)).toEqual([join(documentsRules, 'concord.md')]);

    mkdirSync(join(home, 'Cline', 'Rules'), { recursive: true });
    expect(clineGlobalRulesInstallPaths(env)).toEqual([join(documentsRules, 'concord.md')]);
  });

  it('covers every rules directory Cline resolves, including OneDrive markers', () => {
    const { home, env } = fakeHome();
    const oneDrive = join(home, 'OneDrive');
    const dirs = clineGlobalRulesDirs({
      ...env,
      OneDrive: oneDrive,
      OneDriveConsumer: '',
    });
    expect(dirs).toEqual([
      join(home, '.cline', 'rules'),
      join(home, 'Documents', 'Cline', 'Rules'),
      join(home, 'Cline', 'Rules'),
      join(oneDrive, 'Documents', 'Cline', 'Rules'),
    ]);
    expect(clineGlobalRulesPaths(env)).toContain(
      join(home, 'Documents', 'Cline', 'Rules', 'concord.md'),
    );
  });
});

describe('Cline detection', () => {
  it('detects the CLI on PATH, the home directory, and the Documents directory', () => {
    const { env } = fakeHome();
    expect(clineDetected(env)).toBe(false);

    mkdirSync(clineHome(env), { recursive: true });
    expect(clineDetected(env)).toBe(true);
  });

  it('detects an extension-only install through VS Code globalStorage', () => {
    const { home, env } = fakeHome();
    const extensionDir = join(
      home,
      'AppData',
      'Roaming',
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
    );
    mkdirSync(extensionDir, { recursive: true });

    expect(clineExtensionDetected(env)).toBe(true);
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
      env: { CONCORD_AGENT_KIND: 'cline', CONCORD_MANAGED: 'true' },
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

  it('leaves a hand-written concord-mcp entry alone on install and uninstall', () => {
    const { env } = fakeHome();
    const mcpPath = clineMcpSettingsPath(env);
    mkdirSync(dirname(mcpPath), { recursive: true });
    // A user's own entry that happens to look Concord-shaped: concord-mcp
    // pinned to a repo, but no managed marker.
    const userEntry = {
      mcpServers: {
        concord: {
          command: 'concord-mcp',
          env: { CONCORD_AGENT_KIND: 'cline', CONCORD_REPO_ROOT: '/pinned/repo' },
        },
      },
    };
    writeFileSync(mcpPath, `${JSON.stringify(userEntry, null, 2)}\n`);

    expect(clineEntryIsManaged(readFileSync(mcpPath, 'utf8'))).toBe(false);
    installClineUserConfigs(env);
    expect(JSON.parse(readFileSync(mcpPath, 'utf8'))).toEqual(userEntry);
    uninstallClineUserConfigs(env);
    expect(JSON.parse(readFileSync(mcpPath, 'utf8'))).toEqual(userEntry);
  });

  it('rewrites and removes only marker-carrying concord entries', () => {
    const { env } = fakeHome();
    installClineUserConfigs(env);
    const mcpPath = clineMcpSettingsPath(env);
    expect(clineEntryIsManaged(readFileSync(mcpPath, 'utf8'))).toBe(true);

    // A rerun rewrites the canonical entry and keeps the marker.
    installClineUserConfigs(env);
    expect(clineEntryIsManaged(readFileSync(mcpPath, 'utf8'))).toBe(true);

    uninstallClineUserConfigs(env);
    expect(readMcp(mcpPath).mcpServers).not.toHaveProperty('concord');
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
