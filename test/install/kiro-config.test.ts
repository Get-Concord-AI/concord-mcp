import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  hasKiroHooks,
  installKiroUserConfigs,
  installKiroWorkspaceHooks,
  kiroDetected,
  kiroUserHooksPath,
  kiroUserMcpPath,
  uninstallKiroUserConfigs,
  upsertKiroHooks,
  withoutKiroHooks,
} from '../../src/install/kiro-config.js';
import { McpConfigParseError } from '../../src/install/mcp-config.js';

const hooksFile = z.object({
  version: z.string(),
  hooks: z.array(
    z.object({
      name: z.string(),
      trigger: z.string(),
      action: z.object({ type: z.string(), command: z.string() }),
    }),
  ),
});

const mcpConfig = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});

function parseHooks(content: string): z.infer<typeof hooksFile> {
  return hooksFile.parse(JSON.parse(content));
}

describe('Kiro hooks config', () => {
  it('writes the three lifecycle hooks in the v1 format', () => {
    const parsed = parseHooks(upsertKiroHooks(undefined, '.kiro/hooks/concord.json'));

    expect(parsed.version).toBe('v1');
    expect(parsed.hooks.map((hook) => hook.trigger)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
    ]);
    expect(parsed.hooks.map((hook) => hook.action.command)).toEqual([
      'concord hook kiro-session-start',
      'concord hook kiro-user-prompt-submit',
      'concord hook kiro-stop',
    ]);
  });

  it('preserves unrelated hooks and top-level settings, and reruns unchanged', () => {
    const original = JSON.stringify({
      version: 'v1',
      theme: 'dark',
      hooks: [
        {
          name: 'my-lint',
          trigger: 'PostFileSave',
          action: { type: 'command', command: 'npm run lint' },
        },
      ],
    });

    const installed = upsertKiroHooks(original, '.kiro/hooks/concord.json');
    const parsed = parseHooks(installed);

    expect(installed).toContain('npm run lint');
    expect(JSON.parse(installed)).toMatchObject({ theme: 'dark' });
    expect(parsed.hooks.map((hook) => hook.name)).toEqual([
      'my-lint',
      'concord-session-start',
      'concord-user-prompt-submit',
      'concord-stop',
    ]);
    expect(upsertKiroHooks(installed, '.kiro/hooks/concord.json')).toBe(installed);
  });

  it('replaces its own hooks without duplicating them', () => {
    const once = upsertKiroHooks(undefined, 'hooks.json');
    const twice = upsertKiroHooks(once, 'hooks.json');

    expect(twice.split('"concord-session-start"').length - 1).toBe(1);
    expect(hasKiroHooks(twice)).toBe(true);
  });

  it('rejects malformed JSON and unsupported hook versions', () => {
    expect(() => upsertKiroHooks('{ not json', 'hooks.json')).toThrow(McpConfigParseError);
    expect(() => upsertKiroHooks('{"version":"v2","hooks":[]}', 'hooks.json')).toThrow(
      /unsupported hooks version/u,
    );
    expect(hasKiroHooks('{ not json')).toBe(false);
  });

  it('removes only Concord hooks and deletes the file content when nothing is left', () => {
    const existing = JSON.stringify({
      version: 'v1',
      hooks: [
        { name: 'my-lint', trigger: 'PostFileSave', action: { type: 'command', command: 'lint' } },
      ],
    });
    const installed = upsertKiroHooks(existing, 'hooks.json');

    const removed = withoutKiroHooks(installed);
    expect(removed).toContain('my-lint');
    expect(hasKiroHooks(removed)).toBe(false);
    expect(withoutKiroHooks(upsertKiroHooks(undefined, 'hooks.json'))).toBe('');
  });
});

describe('Kiro installation', () => {
  it('writes workspace hooks atomically and idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-kiro-install-'));
    const relative = installKiroWorkspaceHooks(root);
    const path = join(root, relative);

    expect(relative).toBe(join('.kiro', 'hooks', 'concord.json'));
    const first = readFileSync(path, 'utf8');
    expect(parseHooks(first).hooks).toHaveLength(3);
    installKiroWorkspaceHooks(root);
    expect(readFileSync(path, 'utf8')).toBe(first);
  });

  it('merges user MCP config and hooks, then removes only what Concord wrote', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-home-'));
    const env = { HOME: home };
    const writes = installKiroUserConfigs(env);

    expect(writes).toEqual([kiroUserMcpPath(env), kiroUserHooksPath(env)]);
    const config = mcpConfig.parse(JSON.parse(readFileSync(kiroUserMcpPath(env), 'utf8')));
    expect(config.mcpServers['concord']).toMatchObject({
      command: 'concord-mcp',
      env: { CONCORD_AGENT_KIND: 'kiro' },
    });
    expect(hasKiroHooks(readFileSync(kiroUserHooksPath(env), 'utf8'))).toBe(true);

    installKiroUserConfigs(env);
    expect(
      readFileSync(kiroUserHooksPath(env), 'utf8').split('"concord-session-start"').length - 1,
    ).toBe(1);

    uninstallKiroUserConfigs(env);
    expect(existsSync(kiroUserHooksPath(env))).toBe(false);
    expect(
      mcpConfig.parse(JSON.parse(readFileSync(kiroUserMcpPath(env), 'utf8'))).mcpServers,
    ).not.toHaveProperty('concord');
  });

  it('preserves a user-authored Concord entry and unrelated servers', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-custom-'));
    const env = { HOME: home };
    const path = kiroUserMcpPath(env);
    const custom = {
      mcpServers: {
        concord: { command: 'my-wrapper', args: ['--custom'] },
        other: { command: 'other-server' },
      },
    };
    installKiroUserConfigs(env);
    writeFileSync(path, `${JSON.stringify(custom, null, 2)}\n`);

    installKiroUserConfigs(env);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(custom);

    uninstallKiroUserConfigs(env);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(custom);
    expect(existsSync(kiroUserHooksPath(env))).toBe(false);
  });

  it('detects Kiro from its executable, its home, or the workspace directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-detect-'));
    const repo = mkdtempSync(join(tmpdir(), 'concord-kiro-repo-'));
    expect(kiroDetected(undefined, undefined, { HOME: home })).toBe(false);

    installKiroWorkspaceHooks(repo);
    expect(kiroDetected(undefined, repo, { HOME: home })).toBe(true);
    expect(kiroDetected('/usr/bin/kiro-cli', undefined, { HOME: home })).toBe(true);
  });
});
