import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CONCORD_SERVER_COMMAND,
  CONCORD_SERVER_KEY,
  McpConfigParseError,
  installMcpConfigs,
  upsertMcpServer,
} from '../../src/install/mcp-config.js';

describe('upsertMcpServer', () => {
  it('registers the concord server in an empty config', () => {
    const out = upsertMcpServer(undefined);
    expect(out).toContain('mcpServers');
    expect(out).toContain(CONCORD_SERVER_KEY);
    expect(out).toContain(CONCORD_SERVER_COMMAND);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('is idempotent: re-running produces identical output', () => {
    const once = upsertMcpServer(undefined);
    const twice = upsertMcpServer(once);
    expect(twice).toBe(once);
  });

  it('preserves other servers and unrelated top-level keys', () => {
    const existing = JSON.stringify({
      $schema: 'https://example.test/schema.json',
      mcpServers: { other: { command: 'other-server', args: ['--flag'] } },
    });
    const out = upsertMcpServer(existing);
    expect(out).toContain('"$schema"');
    expect(out).toContain('other-server');
    expect(out).toContain('--flag');
    expect(out).toContain(CONCORD_SERVER_COMMAND);
  });

  it('does not duplicate the server when it is already present', () => {
    const twice = upsertMcpServer(upsertMcpServer(undefined));
    expect(twice.split(CONCORD_SERVER_COMMAND).length - 1).toBe(1);
  });

  it('throws on malformed JSON rather than discarding it', () => {
    expect(() => upsertMcpServer('{ not json')).toThrow();
  });
});

describe('installMcpConfigs', () => {
  it('writes both JSON client targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-mcp-config-'));
    const written = installMcpConfigs(root);

    expect(written).toEqual(['.mcp.json', join('.cursor', 'mcp.json')]);
    for (const relPath of written) {
      expect(existsSync(join(root, relPath))).toBe(true);
      expect(readFileSync(join(root, relPath), 'utf8')).toContain(CONCORD_SERVER_COMMAND);
    }
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
