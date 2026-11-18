import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';

import {
  hasMuseCodeMcpServer,
  installMuseCodeMcpConfig,
  museCodeConfigInstalled,
  museConfigPath,
  museHome,
  removeMuseCodeMcpServer,
  uninstallMuseCodeConfig,
  upsertMuseCodeMcpServer,
} from '../../src/install/muse-code-config.js';

const temporaryHomes: string[] = [];
afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'concord-muse-test-'));
  temporaryHomes.push(home);
  const env = { HOME: home };
  const path = museConfigPath(env);
  return { env, path, home };
}

function writeJson(path: string, json: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
}

const initialSchema = z.object({
  schema_version: z.number(),
  mcpServers: z.record(
    z.string(),
    z.object({
      transport: z.string(),
      command: z.string(),
      mode: z.string(),
    }),
  ),
});

const legacySchema = z.object({
  mcp_servers: z.record(z.string(), z.unknown()).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  other: z.unknown().optional(),
});

describe('Muse Code configuration', () => {
  it('resolves HOME and XDG_CONFIG_HOME paths and ignores MUSE_HOME', () => {
    const { env, home } = fixture();
    expect(museHome(env)).toBe(join(home, '.config', 'muse'));
    expect(museConfigPath(env)).toBe(join(home, '.config', 'muse', 'settings.json'));

    const xdgEnv = { ...env, XDG_CONFIG_HOME: join(home, 'xdg') };
    expect(museHome(xdgEnv)).toBe(join(home, 'xdg', 'muse'));
    expect(museConfigPath(xdgEnv)).toBe(join(home, 'xdg', 'muse', 'settings.json'));

    const customHome = { ...env, MUSE_HOME: join(home, 'custom-muse') };
    expect(museHome(customHome)).toBe(join(home, '.config', 'muse'));
  });

  it('detects missing, empty, legacy, canonical, both-keys, and installed concord entries', () => {
    const { env, path } = fixture();
    expect(museCodeConfigInstalled(env)).toBe(false);

    writeJson(path, '');
    expect(museCodeConfigInstalled(env)).toBe(false);

    writeJson(
      path,
      JSON.stringify({ schema_version: 1, mcp_servers: { other: { command: 'node' } } }),
    );
    expect(museCodeConfigInstalled(env)).toBe(false);
    expect(hasMuseCodeMcpServer(readFileSync(path, 'utf8'))).toBe(false);

    writeJson(
      path,
      JSON.stringify({
        schema_version: 1,
        mcp_servers: {
          concord: { transport: 'stdio', command: 'concord-mcp', mode: 'optional' },
        },
      }),
    );
    expect(museCodeConfigInstalled(env)).toBe(true);

    writeJson(
      path,
      JSON.stringify({
        schema_version: 1,
        mcpServers: {
          concord: { transport: 'stdio', command: 'concord-mcp', mode: 'optional' },
        },
      }),
    );
    expect(museCodeConfigInstalled(env)).toBe(true);

    writeJson(
      path,
      JSON.stringify({
        schema_version: 1,
        mcpServers: {
          concord: { transport: 'stdio', command: 'concord-mcp', mode: 'optional' },
        },
        mcp_servers: {
          concord: { transport: 'stdio', command: 'concord-mcp', mode: 'optional' },
        },
      }),
    );
    expect(museCodeConfigInstalled(env)).toBe(false);
    expect(hasMuseCodeMcpServer(readFileSync(path, 'utf8'))).toBe(false);
  });

  it('upserts concord entry into a missing config with mcpServers and compatible shape', () => {
    const initial = upsertMuseCodeMcpServer(undefined);
    const parsed = initialSchema.parse(JSON.parse(initial));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.mcpServers['concord']?.transport).toBe('stdio');
    expect(parsed.mcpServers['concord']?.command).toBe('concord-mcp');
    expect(parsed.mcpServers['concord']?.mode).toBe('optional');
  });

  it('keeps legacy mcp_servers key when only legacy exists', () => {
    const existing = JSON.stringify({
      schema_version: 1,
      mcp_servers: { other: { command: 'custom-tool' } },
    });
    const updated = upsertMuseCodeMcpServer(existing);
    const raw = legacySchema.parse(JSON.parse(updated));
    expect(raw.mcp_servers?.['other']).toBeDefined();
    expect(raw.mcp_servers?.['concord']).toBeDefined();
    expect(raw.mcpServers).toBeUndefined();
  });

  it('throws when both root keys are present', () => {
    const existing = JSON.stringify({
      schema_version: 1,
      mcpServers: {},
      mcp_servers: {},
    });
    expect(() => upsertMuseCodeMcpServer(existing, 'settings.json')).toThrow(
      /both .*mcpServers.*mcp_servers/i,
    );
  });

  it('preserves existing top-level keys and other servers in canonical file', () => {
    const existing = JSON.stringify({
      schema_version: 2,
      tui: { theme: 'dark' },
      mcpServers: {
        existing_tool: { command: 'custom-tool' },
      },
    });

    const updated = upsertMuseCodeMcpServer(existing);
    const raw = z
      .object({
        schema_version: z.number(),
        tui: z.object({ theme: z.string() }).optional(),
        mcpServers: z.record(z.string(), z.object({ command: z.string() })),
      })
      .parse(JSON.parse(updated));

    expect(raw.schema_version).toBe(2);
    expect(raw.tui?.theme).toBe('dark');
    expect(raw.mcpServers['existing_tool']?.command).toBe('custom-tool');
    expect(raw.mcpServers['concord']?.command).toBe('concord-mcp');
  });

  it('removes only concord from canonical and legacy and cleans empty files', () => {
    const onlyConcord = JSON.stringify({
      schema_version: 1,
      mcpServers: { concord: { transport: 'stdio', command: 'concord-mcp', mode: 'optional' } },
    });
    expect(removeMuseCodeMcpServer(onlyConcord)).toBe('');

    const legacyOnly = JSON.stringify({
      schema_version: 1,
      mcp_servers: { concord: { command: 'concord-mcp' } },
    });
    expect(removeMuseCodeMcpServer(legacyOnly)).toBe('');
  });

  it('preserves custom user-owned concord entry during install and removal', () => {
    const { env, path } = fixture();
    const customConfig = JSON.stringify(
      {
        schema_version: 1,
        mcpServers: {
          concord: {
            command: 'my-custom-wrapper',
            args: ['--debug'],
            env: { CUSTOM_VAR: '1' },
          },
        },
      },
      null,
      2,
    );
    writeJson(path, customConfig);

    installMuseCodeMcpConfig(env);
    expect(readFileSync(path, 'utf8')).toBe(customConfig);

    uninstallMuseCodeConfig(env);
    expect(readFileSync(path, 'utf8')).toBe(customConfig);
  });

  it('safely ignores unreadable or malformed config during uninstall', () => {
    const { env, path } = fixture();
    const broken = '{ malformed json';
    writeJson(path, broken);

    expect(uninstallMuseCodeConfig(env)).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(broken);
  });

  it('installs and uninstalls via filesystem helpers', () => {
    const { env, path } = fixture();
    installMuseCodeMcpConfig(env);
    expect(existsSync(path)).toBe(true);
    expect(museCodeConfigInstalled(env)).toBe(true);
    uninstallMuseCodeConfig(env);
    expect(existsSync(path)).toBe(false);
  });
});
