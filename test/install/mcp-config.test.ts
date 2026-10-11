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
} from '../../src/install/mcp-config.js';

describe('upsertMcpServer', () => {
  it('registers the concord server in an empty config', () => {
    const out = upsertMcpServer(undefined, '/tmp/project', 'claude-code');
    expect(out).toContain('mcpServers');
    expect(out).toContain(CONCORD_SERVER_KEY);
    expect(out).toContain(CONCORD_SERVER_COMMAND);
    expect(out).toContain('"CONCORD_REPO_ROOT": "/tmp/project"');
    expect(out).toContain('"CONCORD_AGENT_KIND": "claude-code"');
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
    const once = upsertGrokMcpServer(existing, '/tmp/project', 'grok');
    const twice = upsertGrokMcpServer(once, '/tmp/project', 'grok');

    expect(twice).toBe(once);
    expect(once).toContain('[ui]');
    expect(once).toContain('[mcp_servers.other]');
    expect(once).toContain('[mcp_servers.concord]');
    expect(once).toContain('CONCORD_REPO_ROOT = "/tmp/project"');
    expect(once).toContain('CONCORD_AGENT_KIND = "grok"');
  });

  it('replaces Grok CLI-generated Concord tables without duplicating them', () => {
    const existing =
      '[mcp_servers.concord]\ncommand = "old"\nargs = []\n\n' +
      '[mcp_servers.concord.env]\nCONCORD_REPO_ROOT = "/old"\n\n[other]\nvalue = true\n';
    const updated = upsertGrokMcpServer(existing, '/new', 'grok');

    expect(updated.match(/\[mcp_servers\.concord\]/gu)).toHaveLength(1);
    expect(updated).not.toContain('command = "old"');
    expect(updated).not.toContain('/old');
    expect(updated).toContain('[other]');
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

  it('leaves malformed global Cursor config untouched', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-home-'));
    const path = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(path, '{ broken\n');

    expect(() => removeGlobalCursorConcord({ HOME: home })).toThrow(McpConfigParseError);
    expect(readFileSync(path, 'utf8')).toBe('{ broken\n');
  });
});
