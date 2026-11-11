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

const settingsSchema = z.object({
  schema_version: z.number(),
  tui: z.object({ theme: z.string() }).optional(),
  mcp_servers: z
    .record(
      z.string(),
      z.object({
        command: z.string(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});

describe('Muse Code configuration', () => {
  it('resolves HOME, XDG_CONFIG_HOME, and MUSE_HOME paths', () => {
    const { env, home } = fixture();
    expect(museHome(env)).toBe(join(home, '.config', 'muse'));
    expect(museConfigPath(env)).toBe(join(home, '.config', 'muse', 'settings.json'));

    const xdgEnv = { ...env, XDG_CONFIG_HOME: join(home, 'xdg') };
    expect(museHome(xdgEnv)).toBe(join(home, 'xdg', 'muse'));
    expect(museConfigPath(xdgEnv)).toBe(join(home, 'xdg', 'muse', 'settings.json'));

    const customHome = { ...env, MUSE_HOME: join(home, 'custom-muse') };
    expect(museHome(customHome)).toBe(join(home, 'custom-muse'));
    expect(museConfigPath(customHome)).toBe(join(home, 'custom-muse', 'settings.json'));
  });

  it('detects missing, empty, and installed concord entries', () => {
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
      JSON.stringify({ schema_version: 1, mcp_servers: { concord: { command: 'concord-mcp' } } }),
    );
    expect(museCodeConfigInstalled(env)).toBe(true);
    expect(hasMuseCodeMcpServer(readFileSync(path, 'utf8'))).toBe(true);
  });

  it('upserts concord entry into a missing or empty config with schema_version 1', () => {
    const initial = upsertMuseCodeMcpServer(undefined);
    const parsed = settingsSchema.parse(JSON.parse(initial));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.mcp_servers?.['concord']?.command).toBe('concord-mcp');
    expect(parsed.mcp_servers?.['concord']?.env?.['CONCORD_AGENT_KIND']).toBe('muse-code');

    const fromEmpty = upsertMuseCodeMcpServer('');
    expect(JSON.parse(fromEmpty)).toEqual(JSON.parse(initial));
  });

  it('preserves existing top-level keys and other mcp_servers', () => {
    const existing = JSON.stringify({
      schema_version: 2,
      tui: { theme: 'dark' },
      mcp_servers: {
        existing_tool: { command: 'custom-tool' },
      },
    });

    const updated = upsertMuseCodeMcpServer(existing);
    const raw: unknown = JSON.parse(updated);
    const verified = settingsSchema.parse(raw);

    expect(verified.schema_version).toBe(2);
    expect(verified.tui?.theme).toBe('dark');
    expect(verified.mcp_servers?.['existing_tool']?.command).toBe('custom-tool');
    expect(verified.mcp_servers?.['concord']?.command).toBe('concord-mcp');
    expect(verified.mcp_servers?.['concord']?.env?.['CONCORD_AGENT_KIND']).toBe('muse-code');
  });

  it('throws an error with path context on malformed JSON or non-object config', () => {
    expect(() => upsertMuseCodeMcpServer('{ invalid-json', 'test/settings.json')).toThrow(
      'test/settings.json is not valid JSON',
    );
    expect(() => upsertMuseCodeMcpServer('["not", "an", "object"]', 'test/settings.json')).toThrow(
      'test/settings.json must be a JSON object',
    );
    expect(() =>
      upsertMuseCodeMcpServer(
        JSON.stringify({ schema_version: 1, mcp_servers: 'invalid' }),
        'test/settings.json',
      ),
    ).toThrow('test/settings.json property "mcp_servers" must be a JSON object');
  });

  it('removes only concord and performs clean removal when no other settings exist', () => {
    const onlyConcord = JSON.stringify({
      schema_version: 1,
      mcp_servers: { concord: { command: 'concord-mcp' } },
    });
    expect(removeMuseCodeMcpServer(onlyConcord)).toBe('');

    const { env, path } = fixture();
    installMuseCodeMcpConfig(env);
    expect(existsSync(path)).toBe(true);
    expect(museCodeConfigInstalled(env)).toBe(true);

    uninstallMuseCodeConfig(env);
    expect(existsSync(path)).toBe(false);
    expect(museCodeConfigInstalled(env)).toBe(false);
  });

  it('preserves other servers and user settings on removal', () => {
    const { env, path } = fixture();
    const existing = JSON.stringify(
      {
        schema_version: 1,
        tui: { theme: 'light' },
        mcp_servers: {
          other: { command: 'other-cli' },
          concord: { command: 'concord-mcp' },
        },
      },
      null,
      2,
    );
    writeJson(path, existing);

    uninstallMuseCodeConfig(env);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    const raw: unknown = JSON.parse(content);
    const verified = settingsSchema.parse(raw);

    expect(verified.tui?.theme).toBe('light');
    expect(verified.mcp_servers?.['other']?.command).toBe('other-cli');
    expect(verified.mcp_servers?.['concord']).toBeUndefined();
  });

  it('does not create a file when uninstalling an absent config', () => {
    const { env, path } = fixture();
    expect(uninstallMuseCodeConfig(env)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it('preserves custom user-owned concord entry during install and removal', () => {
    const { env, path } = fixture();
    const customConfig = JSON.stringify(
      {
        schema_version: 1,
        mcp_servers: {
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
});
