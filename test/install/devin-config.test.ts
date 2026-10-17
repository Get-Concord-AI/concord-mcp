import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  devinMcpConfigPath,
  installDevinMcpConfig,
  removeDevinMcpConfig,
  upsertDevinMcpConfig,
  uninstallDevinMcpConfig,
} from '../../src/install/devin-config.js';
import { installDevinHooks, removeDevinHooks } from '../../src/install/devin-hooks.js';

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'concord-devin-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Devin MCP config', () => {
  it('merges into JSONC without losing comments or other servers and is idempotent', () => {
    const root = tempRoot();
    const dir = join(root, '.devin');
    mkdirSync(dir);
    const path = join(dir, 'mcp_config.json');
    writeFileSync(
      path,
      '{\n  // keep this note\n  "mcpServers": {\n    // keep server comment\n    "other": { "command": "x" }\n  }\n}\n',
    );

    installDevinMcpConfig({}, root);
    const first = readFileSync(path, 'utf8');
    installDevinMcpConfig({}, root);

    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(first).toContain('// keep this note');
    expect(first).toContain('"other"');
    expect(first).toContain('"concord"');
    expect(uninstallDevinMcpConfig({}, root)).toBe(path);
    expect(readFileSync(path, 'utf8')).toContain('// keep this note');
    expect(readFileSync(path, 'utf8')).toContain('// keep server comment');
    expect(readFileSync(path, 'utf8')).toContain('"other"');
    expect(readFileSync(path, 'utf8')).not.toContain('"concord"');
  });

  it('parses escaped Windows paths and removes the Concord property by its key position', () => {
    const original = JSON.stringify({
      mcpServers: {
        other: { command: 'concord', args: ['C:\\Users\\test\\'] },
        concord: { command: 'concord-mcp' },
      },
    });

    const installed = upsertDevinMcpConfig(original);
    expect(JSON.parse(installed)).toMatchObject({
      mcpServers: {
        other: { command: 'concord', args: ['C:\\Users\\test\\'] },
        concord: { command: 'concord-mcp' },
      },
    });
    const removed = removeDevinMcpConfig(installed);
    expect(JSON.parse(removed)).toEqual({
      mcpServers: { other: { command: 'concord', args: ['C:\\Users\\test\\'] } },
    });
  });

  it('adds lifecycle hooks idempotently and removes only Concord hooks', () => {
    const root = tempRoot();
    const dir = join(root, '.devin');
    mkdirSync(dir);
    const path = join(dir, 'hooks.v1.json');
    writeFileSync(
      path,
      JSON.stringify({
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'echo user' },
              { type: 'command', command: 'concord hook devin-user-prompt-submit' },
            ],
          },
        ],
      }),
    );

    installDevinHooks(root);
    const first = readFileSync(path, 'utf8');
    installDevinHooks(root);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(first).toContain('devin-user-prompt-submit');
    expect(removeDevinHooks(root)).toBe(join('.devin', 'hooks.v1.json'));
    expect(readFileSync(path, 'utf8')).toContain('echo user');
    expect(readFileSync(path, 'utf8')).not.toContain('concord hook devin-');
  });

  it('uses APPDATA for Windows user MCP config and never targets local secrets', () => {
    const appData = 'C:\\Users\\test\\AppData\\Roaming';
    expect(devinMcpConfigPath({ APPDATA: appData })).toBe(
      join(appData, 'devin', 'mcp_config.json'),
    );
    expect(devinMcpConfigPath({ HOME: 'C:\\Users\\test' }, 'C:\\repo')).toBe(
      join('C:\\repo', '.devin', 'mcp_config.json'),
    );
    expect(devinMcpConfigPath({}, 'C:\\repo')).not.toContain('mcp_config.local.json');
  });

  it('leaves malformed config untouched', () => {
    const root = tempRoot();
    const dir = join(root, '.devin');
    mkdirSync(dir);
    const path = join(dir, 'mcp_config.json');
    writeFileSync(path, '{ broken');
    expect(() => installDevinMcpConfig({}, root)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{ broken');
  });
});
