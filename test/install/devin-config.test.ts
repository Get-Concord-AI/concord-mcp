import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  devinMcpConfigPath,
  installDevinMcpConfig,
  removeDevinMcpConfig,
  upsertDevinMcpConfig,
  uninstallDevinMcpConfig,
} from '../../src/install/devin-config.js';
import { installDevinHooks, removeDevinHooks } from '../../src/install/devin-hooks.js';
import { resolveIdentity } from '../../src/domain/identity.js';

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

  it('removes Concord with whitespace and comments before the following comma', () => {
    const source =
      '{\n  "mcpServers": {\n    "concord": { "command": "concord-mcp" } /* user note */ ,\n    "other": { "command": "x" }\n  }\n}';
    const removed = removeDevinMcpConfig(source);

    expect(JSON.parse(removed.replace('/* user note */', ''))).toEqual({
      mcpServers: { other: { command: 'x' } },
    });
    expect(removed).toContain('/* user note */');
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

  it('names the Devin kind so an inherited Claude Code session is never adopted', () => {
    const fresh = z
      .object({
        mcpServers: z.object({
          concord: z.object({ command: z.string(), env: z.record(z.string(), z.string()) }),
        }),
      })
      .parse(JSON.parse(upsertDevinMcpConfig(undefined))).mcpServers.concord;

    expect(fresh).toEqual({ command: 'concord-mcp', env: { CONCORD_AGENT_KIND: 'devin' } });
    // The server it starts reads only Devin's (absent) session sources, so the
    // agent_id the session-start hook gave the model is the one used.
    expect(
      resolveIdentity({ CLAUDE_CODE_SESSION_ID: 'claude-session' }, { kind: 'devin' }),
    ).toBeUndefined();
  });

  it('upgrades an earlier entry, keeping the user’s own env', () => {
    const earlier = JSON.stringify({
      mcpServers: { concord: { command: 'concord-mcp', env: { CONCORD_REPO_ROOT: '/repo' } } },
    });

    const upgraded = upsertDevinMcpConfig(earlier);

    expect(JSON.parse(upgraded)).toEqual({
      mcpServers: {
        concord: {
          command: 'concord-mcp',
          env: { CONCORD_REPO_ROOT: '/repo', CONCORD_AGENT_KIND: 'devin' },
        },
      },
    });
    expect(upsertDevinMcpConfig(upgraded)).toBe(upgraded);
  });
});
