import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, type ParseError } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  inspectOpenCodeMcpConfig,
  installOpenCodeMcpConfig,
  removeOpenCodeMcpConfig,
  upsertOpenCodeMcpServer,
} from '../../src/install/opencode-config.js';

function parsedConfig(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  expect(errors).toEqual([]);
  return z.record(z.string(), z.unknown()).parse(parsed);
}

describe('OpenCode repository MCP config', () => {
  it('merges the Concord server into JSONC and preserves other settings and comments', () => {
    const existing = [
      '{',
      '  // Keep project options and this comment.',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "theme": "tokyo-night",',
      '  "mcp": { "servers": { "metrics": { "type": "remote", "url": "https://mcp.test" } } }',
      '}',
      '',
    ].join('\n');

    const once = upsertOpenCodeMcpServer(existing);
    const twice = upsertOpenCodeMcpServer(once);
    const config = parsedConfig(once);

    expect(twice).toBe(once);
    expect(once).toContain('// Keep project options and this comment.');
    expect(config).toMatchObject({
      theme: 'tokyo-night',
      mcp: {
        servers: {
          metrics: { type: 'remote', url: 'https://mcp.test' },
          concord: {
            type: 'local',
            command: ['concord-mcp'],
            environment: { CONCORD_AGENT_KIND: 'opencode' },
          },
        },
      },
    });
    expect(once).not.toContain('CONCORD_REPO_ROOT');
  });

  it('updates an existing JSONC entry in place when both config names exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-opencode-config-'));
    const jsonPath = join(root, 'opencode.json');
    const jsoncPath = join(root, 'opencode.jsonc');
    const json = '{"theme":"plain"}\n';
    writeFileSync(jsonPath, json);
    writeFileSync(
      jsoncPath,
      '{\n  // Existing Concord entry\n  "mcp": { "servers": { "concord": { "type": "local", "command": ["concord-mcp"], "environment": { "CONCORD_AGENT_KIND": "opencode" } } } }\n}\n',
    );

    expect(installOpenCodeMcpConfig(root)).toBe('opencode.jsonc');
    expect(inspectOpenCodeMcpConfig(root)).toEqual({
      kind: 'configured',
      relPath: 'opencode.jsonc',
    });
    expect(readFileSync(jsonPath, 'utf8')).toBe(json);
    expect(readFileSync(jsoncPath, 'utf8')).toContain('// Existing Concord entry');
  });

  it('leaves a custom Concord entry untouched for install and uninstall', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-opencode-custom-'));
    const configPath = join(root, 'opencode.json');
    mkdirSync(root, { recursive: true });
    const existing =
      '{"mcp":{"servers":{"concord":{"type":"remote","url":"https://custom.test"}}}}\n';
    writeFileSync(configPath, existing);

    installOpenCodeMcpConfig(root);

    expect(inspectOpenCodeMcpConfig(root)).toEqual({ kind: 'custom', relPath: 'opencode.json' });
    expect(readFileSync(configPath, 'utf8')).toBe(existing);
    expect(removeOpenCodeMcpConfig(root)).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(existing);
  });

  it('reports and re-enables a disabled owned entry, then removes only that entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-opencode-disabled-'));
    const configPath = join(root, 'opencode.json');
    writeFileSync(
      configPath,
      '{\n  "theme": "dark",\n  "mcp": { "servers": { "concord": { "type": "local", "command": ["concord-mcp"], "environment": { "CONCORD_AGENT_KIND": "opencode" }, "disabled": true }, "metrics": { "type": "remote", "url": "https://mcp.test" } } }\n}\n',
    );

    expect(inspectOpenCodeMcpConfig(root)).toEqual({ kind: 'disabled', relPath: 'opencode.json' });
    installOpenCodeMcpConfig(root);
    expect(inspectOpenCodeMcpConfig(root)).toEqual({
      kind: 'configured',
      relPath: 'opencode.json',
    });
    expect(removeOpenCodeMcpConfig(root)).toBe('opencode.json');

    expect(parsedConfig(readFileSync(configPath, 'utf8'))).toMatchObject({
      theme: 'dark',
      mcp: { servers: { metrics: { url: 'https://mcp.test' } } },
    });
  });

  it('refuses to choose between two files that both define Concord', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-opencode-duplicate-'));
    const entry =
      '{"mcp":{"servers":{"concord":{"type":"local","command":["concord-mcp"],"environment":{"CONCORD_AGENT_KIND":"opencode"}}}}}\n';
    writeFileSync(join(root, 'opencode.json'), entry);
    writeFileSync(join(root, 'opencode.jsonc'), entry);

    expect(() => installOpenCodeMcpConfig(root)).toThrow(/both define a Concord MCP server/u);
  });
});
