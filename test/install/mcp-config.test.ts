import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CONCORD_SERVER_COMMAND,
  CONCORD_SERVER_KEY,
  McpConfigParseError,
  installMcpConfigs,
  removeGlobalCursorConcord,
  upsertGeminiSettings,
  upsertGrokMcpServer,
  upsertMcpServer,
  hasGrokMcpServer,
  removeGrokMcpServer,
} from '../../src/install/mcp-config.js';

describe('upsertMcpServer', () => {
  it('registers the concord server in an empty config', () => {
    const out = upsertMcpServer(undefined, '/tmp/project', 'claude-code');
    expect(out).toContain('mcpServers');
    expect(out).toContain(CONCORD_SERVER_KEY);
    expect(out).toContain(CONCORD_SERVER_COMMAND);
    expect(out).toContain('"CONCORD_REPO_ROOT": "/tmp/project"');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('is idempotent: re-running produces identical output', () => {
    const once = upsertMcpServer(undefined, '/tmp/project', 'claude-code');
    const twice = upsertMcpServer(once, '/tmp/project', 'claude-code');
    expect(twice).toBe(once);
  });

  it('preserves other servers and unrelated top-level keys', () => {
    const existing = JSON.stringify({
      $schema: 'https://example.test/schema.json',
      mcpServers: { other: { command: 'other-server', args: ['--flag'] } },
    });
    const out = upsertMcpServer(existing, '/tmp/project', 'claude-code');
    expect(out).toContain('"$schema"');
    expect(out).toContain('other-server');
    expect(out).toContain('--flag');
    expect(out).toContain(CONCORD_SERVER_COMMAND);
  });

  it('does not duplicate the server when it is already present', () => {
    const twice = upsertMcpServer(
      upsertMcpServer(undefined, '/tmp/project', 'claude-code'),
      '/tmp/project',
      'claude-code',
    );
    expect(twice.split(CONCORD_SERVER_COMMAND).length - 1).toBe(1);
  });

  it('throws on malformed JSON rather than discarding it', () => {
    expect(() => upsertMcpServer('{ not json', '/tmp/project', 'claude-code')).toThrow();
  });
});

describe('installMcpConfigs', () => {
  it('writes every project-scoped harness target', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-mcp-config-'));
    const written = installMcpConfigs(root);

    expect(written).toEqual([
      '.mcp.json',
      join('.cursor', 'mcp.json'),
      join('.github', 'mcp.json'),
      join('.gemini', 'settings.json'),
      join('.grok', 'config.toml'),
    ]);
    for (const relPath of written) {
      expect(existsSync(join(root, relPath))).toBe(true);
      const content = readFileSync(join(root, relPath), 'utf8');
      expect(content).toContain(CONCORD_SERVER_COMMAND);
      expect(content).toContain(root);
    }
    const gemini = z
      .object({
        tools: z.object({ shell: z.object({ backgroundCompletionBehavior: z.string() }) }),
        experimental: z.object({ modelSteering: z.boolean() }),
      })
      .parse(JSON.parse(readFileSync(join(root, '.gemini', 'settings.json'), 'utf8')));
    expect(gemini.tools.shell.backgroundCompletionBehavior).toBe('inject');
    expect(gemini.experimental.modelSteering).toBe(true);
  });

  it('is idempotent and preserves an existing server', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-mcp-config-'));
    writeFileSync(
      join(root, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }, null, 2)}\n`,
    );

    installMcpConfigs(root);
    const first = readFileSync(join(root, '.mcp.json'), 'utf8');
    installMcpConfigs(root);
    const second = readFileSync(join(root, '.mcp.json'), 'utf8');

    expect(first).toContain('other-server');
    expect(first).toContain(CONCORD_SERVER_COMMAND);
    expect(second).toBe(first);
  });

  it('reports the offending path and leaves malformed config untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-mcp-config-'));
    const broken = '{ this is not json\n';
    writeFileSync(join(root, '.mcp.json'), broken);

    expect(() => installMcpConfigs(root)).toThrow(McpConfigParseError);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(broken);
  });
});

describe('upsertGeminiSettings', () => {
  it('enables completion injection and preserves existing Gemini settings', () => {
    const existing = JSON.stringify({
      theme: 'dark',
      tools: { shell: { enableInteractiveShell: true }, custom: { enabled: true } },
      experimental: { customFeature: true },
      mcpServers: { other: { command: 'other' } },
    });
    const once = upsertGeminiSettings(existing, '/tmp/project', 'gemini');
    const twice = upsertGeminiSettings(once, '/tmp/project', 'gemini');
    const parsed = z
      .object({
        theme: z.string(),
        tools: z.object({
          shell: z.object({
            enableInteractiveShell: z.boolean(),
            backgroundCompletionBehavior: z.string(),
          }),
          custom: z.object({ enabled: z.boolean() }),
        }),
        mcpServers: z.record(z.string(), z.unknown()),
        experimental: z.object({ customFeature: z.boolean(), modelSteering: z.boolean() }),
      })
      .parse(JSON.parse(once));

    expect(twice).toBe(once);
    expect(parsed.theme).toBe('dark');
    expect(parsed.tools.shell).toEqual({
      enableInteractiveShell: true,
      backgroundCompletionBehavior: 'inject',
    });
    expect(parsed.tools.custom.enabled).toBe(true);
    expect(parsed.mcpServers).toHaveProperty('other');
    expect(parsed.mcpServers).toHaveProperty(CONCORD_SERVER_KEY);
    expect(parsed.experimental).toEqual({ customFeature: true, modelSteering: true });
  });
});

describe('upsertGrokMcpServer', () => {
  it('is idempotent and preserves unrelated TOML tables', () => {
    const existing = '[ui]\nscreen_mode = "minimal"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const once = upsertGrokMcpServer(existing, '/tmp/project');
    const twice = upsertGrokMcpServer(once, '/tmp/project');

    expect(twice).toBe(once);
    expect(once).toContain('[ui]');
    expect(once).toContain('[mcp_servers.other]');
    expect(once).toContain('[mcp_servers.concord]');
    expect(once).toContain('CONCORD_REPO_ROOT = "/tmp/project"');
  });

  it('replaces Grok CLI-generated Concord tables without duplicating them', () => {
    const existing =
      '[mcp_servers.concord]\ncommand = "old"\nargs = []\n\n' +
      '[mcp_servers.concord.env]\nCONCORD_REPO_ROOT = "/old"\n\n[other]\nvalue = true\n';
    const updated = upsertGrokMcpServer(existing, '/new');

    expect(updated.match(/\[mcp_servers\.concord\]/gu)).toHaveLength(1);
    expect(updated).not.toContain('command = "old"');
    expect(updated).not.toContain('/old');
    expect(updated).toContain('[other]');
  });

  it('refuses an inline mcp_servers table, which TOML cannot add a table to', () => {
    expect(() => upsertGrokMcpServer('mcp_servers = { other = { command = "x" } }\n')).toThrow(
      McpConfigParseError,
    );
    const dotted = upsertGrokMcpServer('mcp_servers.other.command = "x"\n');
    expect(dotted).toContain('[mcp_servers.concord]');
    const afterString = 'prompt = """\n[example]\n"""\nmcp_servers = { other = {} }\n';
    expect(() => upsertGrokMcpServer(afterString)).toThrow(McpConfigParseError);
  });

  it('keeps a multi-line string that quotes a Concord table, and what follows it', () => {
    for (const quote of ['"""', "'''"]) {
      const existing =
        `prompt = ${quote}\n[mcp_servers.concord]\ncommand = "quoted"\n${quote}\n` +
        'after = true\n';
      expect(removeGrokMcpServer(existing)).toBe(existing.trimEnd());
      const updated = upsertGrokMcpServer(existing);
      expect(updated.startsWith(existing)).toBe(true);
      expect(updated.match(/^\[mcp_servers\.concord\]$/gmu)).toHaveLength(2);
    }
  });

  it('still replaces its own tables when one holds a multi-line string', () => {
    const existing =
      '[mcp_servers.concord]\ncommand = "old"\nnote = """\n[other]\n"""\n\n[ui]\nmode = 1\n';
    expect(removeGrokMcpServer(existing)).toBe('[ui]\nmode = 1');
  });

  it('reads quotes inside single-line strings and comments as text', () => {
    for (const before of [`a = '"""'`, "a = \"'''\"", '# """ opens nothing', "a = 1 # '''"]) {
      expect(() => upsertGrokMcpServer(`${before}\nmcp_servers = { other = {} }\n`)).toThrow(
        McpConfigParseError,
      );
      const existing = `${before}\n[mcp_servers.concord]\ncommand = "old"\n`;
      expect(removeGrokMcpServer(existing)).toBe(before);
    }
  });
});

describe('a server whose quoted name contains a dot', () => {
  it('is not mistaken for Concord, so its table survives', () => {
    const other = '[mcp_servers."concord.env"]\ncommand = "other"\n';
    expect(hasGrokMcpServer(other)).toBe(false);
    expect(removeGrokMcpServer(other)).toBe(other.trimEnd());
    expect(upsertGrokMcpServer(other)).toContain('command = "other"');
  });
});

describe('removeGlobalCursorConcord', () => {
  it('does not fall back to the real home in an isolated environment', () => {
    expect(removeGlobalCursorConcord({})).toBeUndefined();
  });

  it('removes only the shadowing global Concord server', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-home-'));
    const path = join(home, '.cursor', 'mcp.json');
    const existing = {
      telemetry: false,
      mcpServers: {
        other: { command: 'other-server', args: ['--flag'] },
        concord: { command: 'npx', args: ['-y', '@concord-ai/concord-mcp@latest'] },
      },
    };
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);

    expect(removeGlobalCursorConcord({ HOME: home })).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      telemetry: false,
      mcpServers: { other: existing.mcpServers.other },
    });
    expect(removeGlobalCursorConcord({ HOME: home })).toBeUndefined();
  });

  it("keeps a user's own concord server that uses a different command", () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-home-'));
    const path = join(home, '.cursor', 'mcp.json');
    const mine = { command: 'my-own-concord', args: ['--custom'] };
    const existing = {
      telemetry: false,
      mcpServers: { other: { command: 'other' }, concord: mine },
    };
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);

    expect(removeGlobalCursorConcord({ HOME: home })).toBeUndefined();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(existing);
  });

  it('keeps a custom server whose path merely contains the package name', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-home-'));
    const path = join(home, '.cursor', 'mcp.json');
    const mine = { command: 'node', args: ['/opt/@concord-ai/concord-mcp-wrapper/server.js'] };
    const existing = { mcpServers: { concord: mine } };
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);

    expect(removeGlobalCursorConcord({ HOME: home })).toBeUndefined();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(existing);
  });

  it('removes an entry pinned to a version of the published package', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-home-'));
    const path = join(home, '.cursor', 'mcp.json');
    const existing = {
      mcpServers: {
        concord: { command: 'npx', args: ['-y', '@concord-ai/concord-mcp@0.9.1'] },
      },
    };
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);

    expect(removeGlobalCursorConcord({ HOME: home })).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: {} });
  });

  it('keeps an entry whose arguments are not all strings', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-home-'));
    const path = join(home, '.cursor', 'mcp.json');
    const existing = { mcpServers: { concord: { command: 'npx', args: ['-y', 42] } } };
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);

    expect(removeGlobalCursorConcord({ HOME: home })).toBeUndefined();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(existing);
  });

  it('removes an entry that points at the published package under another name', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-home-'));
    const path = join(home, '.cursor', 'mcp.json');
    const existing = {
      mcpServers: {
        concord: { command: 'bunx', args: ['@concord-ai/concord-mcp@latest'] },
      },
    };
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);

    expect(removeGlobalCursorConcord({ HOME: home })).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: {} });
  });

  it('leaves malformed global Cursor config untouched', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-home-'));
    const path = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(path, '{ broken\n');

    expect(() => removeGlobalCursorConcord({ HOME: home })).toThrow(McpConfigParseError);
    expect(readFileSync(path, 'utf8')).toBe('{ broken\n');
  });
});

describe('hasGrokMcpServer', () => {
  it('recognises every TOML spelling of a Concord registration, and nothing else', () => {
    for (const toml of [
      '[mcp_servers.concord]\ncommand = "x"',
      "[ mcp_servers . 'concord' ]\ncommand = 'x'",
      '[mcp_servers.concord.env]\nA = "1"',
      '[mcp_servers]\nconcord = { command = "x" }',
      'mcp_servers.concord.command = "x"',
      'mcp_servers = { concord = { command = "x" } }',
      'mcp_servers = { other = { command = "y" }, "concord" = { command = "x" } }',
      'mcp_servers = { concord.command = "x" }',
    ]) {
      expect(hasGrokMcpServer(toml)).toBe(true);
    }
    for (const toml of [
      '[mcp_servers.concordx]\ncommand = "x"',
      '[mcp_servers]\nconcord_x = { command = "x" }',
      '[other]\nconcord = { command = "x" }',
      '# [mcp_servers.concord]',
      'prompt = """\n[mcp_servers.concord]\n"""',
      'mcp_servers = { other = { concord = "x" } }',
      'mcp_servers = { other = "concord = 1" }',
    ]) {
      expect(hasGrokMcpServer(toml)).toBe(false);
    }
  });
});
