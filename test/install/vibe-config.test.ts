import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hasVibeMcpServer,
  installVibeMcpConfig,
  uninstallVibeMcpConfig,
  upsertVibeMcpConfig,
  vibeMcpConfigPath,
  vibeMcpInstalled,
} from '../../src/install/vibe-config.js';

const dirs: string[] = [];

function tempEnv(): { env: NodeJS.ProcessEnv; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'vibe-config-'));
  dirs.push(home);
  return { env: { VIBE_HOME: join(home, '.vibe') }, home };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('upsertVibeMcpConfig', () => {
  it('writes a managed stdio block into an empty config', () => {
    const next = upsertVibeMcpConfig(undefined);
    expect(next).toContain('[[mcp_servers]]');
    expect(next).toContain('name = "concord"');
    expect(next).toContain('transport = "stdio"');
    expect(next).toContain('command = "concord-mcp"');
    expect(next).toContain('CONCORD_AGENT_KIND = "vibe"');
  });

  it('preserves unrelated TOML and other mcp_servers entries', () => {
    const source = [
      'theme = "dark"',
      '',
      '[[mcp_servers]]',
      'name = "other"',
      'transport = "stdio"',
      'command = "other-server"',
      '',
      '[models]',
      'default = "mistral-medium"',
      '',
    ].join('\n');
    const next = upsertVibeMcpConfig(source);
    expect(next).toContain('theme = "dark"');
    expect(next).toContain('name = "other"');
    expect(next).toContain('[models]');
    expect(next).toContain('default = "mistral-medium"');
    expect(next).toContain('name = "concord"');
  });

  it('is idempotent', () => {
    const once = upsertVibeMcpConfig('theme = "auto"\n');
    const twice = upsertVibeMcpConfig(once);
    expect(twice).toBe(once);
  });

  it("keeps a concord-named block that is not Concord-shaped as the user's own", () => {
    // Main's policy (#361): a hand-written `concord` server is never replaced.
    const foreign = [
      [
        '[[mcp_servers]]',
        'name = "concord"',
        'transport = "stdio"',
        'command = "old-command"',
        '',
      ].join('\n'),
      [
        '[[mcp_servers]]',
        'name = "concord"',
        'transport = "stdio"',
        'command = "concord-mcp"',
        'env = { CONCORD_AGENT_KIND = "vibe", API_KEY = "x" }',
        '',
      ].join('\n'),
      [
        '[[mcp_servers]]',
        'name = "concord"',
        'transport = "stdio"',
        'command = "./scripts/concord-wrapper.sh"',
        '',
      ].join('\n'),
    ];
    for (const source of foreign) {
      expect(upsertVibeMcpConfig(source)).toBe(source);
    }
  });

  it('does not treat a different server named concord-ish as ours', () => {
    const source = ['[[mcp_servers]]', 'name = "concord-tools"', 'command = "x"', ''].join('\n');
    const next = upsertVibeMcpConfig(source);
    expect(next).toContain('name = "concord-tools"');
    expect(next).toContain('name = "concord"');
  });

  it('keeps lookalike tables inside multi-line strings untouched', () => {
    const source = [
      'notes = """',
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      '"""',
      '',
    ].join('\n');
    const next = upsertVibeMcpConfig(source);
    expect(next).toContain('notes = """\n[[mcp_servers]]\nname = "concord"');
    // One real managed block is appended; the string's copy is not ours.
    expect(next.match(/\[\[mcp_servers\]\]/gu)).toHaveLength(2);
    expect(hasVibeMcpServer(next)).toBe(true);
  });

  it('removes child tables together with their parent block', () => {
    const source = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      '',
      '[mcp_servers.env]',
      'CONCORD_AGENT_KIND = "vibe"',
      '',
      '[[mcp_servers]]',
      'name = "other"',
      'command = "x"',
      '',
    ].join('\n');
    const next = upsertVibeMcpConfig(source);
    // The child table left with its parent; only the new block's inline env remains.
    expect(next).not.toContain('[mcp_servers.env]');
    expect(next).not.toMatch(/^CONCORD_AGENT_KIND = "vibe"$/mu);
    expect(next).toContain('name = "other"');
    expect(next.match(/\[\[mcp_servers\]\]/gu)).toHaveLength(2);
    expect(hasVibeMcpServer(next)).toBe(true);
  });

  it('reads env keys from a child table that carries a trailing comment', () => {
    const source = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      '',
      '[mcp_servers.env] # credentials',
      'API_KEY = "user-secret"',
      'CONCORD_AGENT_KIND = "vibe"',
      '',
    ].join('\n');
    // The foreign API_KEY makes the entry user-owned: setup must not replace it.
    expect(upsertVibeMcpConfig(source)).toBe(source);
  });

  it('counts quoted env keys inside an inline env table', () => {
    const source = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      'env = { "API.KEY" = "x", CONCORD_AGENT_KIND = "vibe" }',
      '',
    ].join('\n');
    expect(upsertVibeMcpConfig(source)).toBe(source);
  });

  it('treats env content it cannot name as user-owned', () => {
    for (const envLine of ['env = { A.B = "x" }', 'env = { NESTED = { INNER = "x" } }']) {
      const source = [
        '[[mcp_servers]]',
        'name = "concord"',
        'transport = "stdio"',
        'command = "concord-mcp"',
        envLine,
        '',
      ].join('\n');
      expect(upsertVibeMcpConfig(source)).toBe(source);
    }
  });

  it('treats a concord entry with extra user settings as user-owned', () => {
    for (const extra of [
      'cwd = "/home/user/project"',
      'args = ["--verbose"]',
      'enabled = false',
      'timeout = 30',
    ]) {
      const source = [
        '[[mcp_servers]]',
        'name = "concord"',
        'transport = "stdio"',
        'command = "concord-mcp"',
        extra,
        'env = { CONCORD_AGENT_KIND = "vibe" }',
        '',
      ].join('\n');
      // Setup must not replace it.
      expect(upsertVibeMcpConfig(source)).toBe(source);
    }
  });

  it('leaves a concord entry with custom cwd untouched on uninstall', () => {
    const { env } = tempEnv();
    const source = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      'cwd = "/home/user/project"',
      '',
    ].join('\n');
    const path = vibeMcpConfigPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    expect(uninstallVibeMcpConfig(env)).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(source);
  });

  it('treats nested env subtables as user-owned', () => {
    const source = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      '',
      '[mcp_servers.env.credentials]',
      'TOKEN = "user-secret"',
      '',
    ].join('\n');
    expect(upsertVibeMcpConfig(source)).toBe(source);
  });

  it('converts an empty mcp_servers array instead of breaking the file', () => {
    const next = upsertVibeMcpConfig('mcp_servers = []\n');
    expect(next).not.toContain('mcp_servers = []');
    expect(next).toContain('[[mcp_servers]]');
    expect(hasVibeMcpServer(next)).toBe(true);
  });

  it('converts quoted empty mcp_servers keys instead of breaking the file', () => {
    for (const source of ['"mcp_servers" = []\n', "'mcp_servers' = []\n"]) {
      const next = upsertVibeMcpConfig(source);
      expect(next).not.toContain('= []');
      expect(next).toContain('[[mcp_servers]]');
      expect(hasVibeMcpServer(next)).toBe(true);
    }
  });

  it('leaves quoted non-empty mcp_servers keys untouched', () => {
    const source = '"mcp_servers" = [{ name = "x" }]\n';
    expect(upsertVibeMcpConfig(source)).toBe(source);
  });

  it('treats quoted child headers as part of their parent block', () => {
    const source = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      '',
      '["mcp_servers".env]',
      'CONCORD_AGENT_KIND = "vibe"',
      '',
      '[[mcp_servers]]',
      'name = "other"',
      'command = "x"',
      '',
    ].join('\n');
    const next = upsertVibeMcpConfig(source);
    expect(next).not.toContain('"mcp_servers".env');
    expect(next).toContain('name = "other"');
    expect(next.match(/\[\[mcp_servers\]\]/gu)).toHaveLength(2);
  });

  it('leaves a non-empty mcp_servers value untouched', () => {
    const source = 'mcp_servers = [{ name = "x" }]\n';
    expect(upsertVibeMcpConfig(source)).toBe(source);
  });

  it('does not count a concord block with drifted fields as installed', () => {
    const drifted = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "something-else"',
      '',
    ].join('\n');
    expect(hasVibeMcpServer(drifted)).toBe(false);
  });

  it('accepts single-quoted TOML literal strings in owned blocks', () => {
    const literal = [
      '[[mcp_servers]]',
      "name = 'concord'",
      "transport = 'stdio'",
      "command = 'concord-mcp'",
      '',
    ].join('\n');
    expect(hasVibeMcpServer(literal)).toBe(true);
  });
});

describe('vibeMcpConfigPath and install', () => {
  it('expands a leading ~ in VIBE_HOME against the user home', () => {
    const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    dirs.push(home);
    const env = { VIBE_HOME: '~/vibe-alt', HOME: home };
    expect(vibeMcpConfigPath(env)).toBe(join(home, 'vibe-alt', 'config.toml'));
  });

  it('honours VIBE_HOME and installs once', () => {
    const { env, home } = tempEnv();
    const path = vibeMcpConfigPath(env);
    expect(path).toBe(join(home, '.vibe', 'config.toml'));
    installVibeMcpConfig(env);
    const written = readFileSync(path, 'utf8');
    expect(hasVibeMcpServer(written)).toBe(true);
    expect(vibeMcpInstalled(env)).toBe(true);
    // Second install is a no-op.
    installVibeMcpConfig(env);
    expect(readFileSync(path, 'utf8')).toBe(written);
  });

  it('removes only the concord block on uninstall', () => {
    const { env } = tempEnv();
    const path = vibeMcpConfigPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        'theme = "auto"',
        '',
        '[[mcp_servers]]',
        'name = "concord"',
        'transport = "stdio"',
        'command = "concord-mcp"',
        '',
        '[[mcp_servers]]',
        'name = "other"',
        'command = "other"',
        '',
      ].join('\n'),
    );
    uninstallVibeMcpConfig(env);
    const next = readFileSync(path, 'utf8');
    expect(next).not.toContain('name = "concord"');
    expect(next).toContain('name = "other"');
    expect(next).toContain('theme = "auto"');
    expect(vibeMcpInstalled(env)).toBe(false);
  });

  it('uninstall keeps a hand-written concord server and removes ours', () => {
    const { env } = tempEnv();
    const path = vibeMcpConfigPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        '[[mcp_servers]]',
        'name = "concord"',
        'transport = "stdio"',
        'command = "concord-mcp"',
        'env = { CONCORD_AGENT_KIND = "vibe" }',
        '',
        '[[mcp_servers]]',
        'name = "concord"',
        'transport = "stdio"',
        'command = "./my-wrapper.sh"',
        '',
      ].join('\n'),
    );
    uninstallVibeMcpConfig(env);
    const next = readFileSync(path, 'utf8');
    expect(next).not.toContain('concord-mcp');
    expect(next).toContain('my-wrapper.sh');
    expect(next.match(/name = "concord"/gu)).toHaveLength(1);
  });

  it('uninstall leaves an unreadable config.toml untouched without throwing', () => {
    const { env } = tempEnv();
    const path = vibeMcpConfigPath(env);
    // A directory where the file should be makes readFileSync throw.
    mkdirSync(path, { recursive: true });
    expect(uninstallVibeMcpConfig(env)).toBeUndefined();
  });
});

describe('round-3 review regressions', () => {
  it('does not append [[mcp_servers]] when [mcp_servers.env] follows an unrelated table', () => {
    const src = [
      '[other]',
      'x = 1',
      '',
      '[mcp_servers.env]',
      'FOO = "bar"',
      '',
    ].join('\n');
    // Appending an array-of-tables here would redefine a table TOML already
    // has, so the file must be left exactly as it is.
    expect(upsertVibeMcpConfig(src)).toBe(src);
  });

  it('still appends when unrelated tables exist but no mcp_servers table does', () => {
    const src = ['[other]', 'x = 1', ''].join('\n');
    const next = upsertVibeMcpConfig(src);
    expect(next).toContain('[[mcp_servers]]');
    expect(next).toContain('[other]');
  });

  it('treats a block with an unnameable assignment line as user-owned', () => {
    const src = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      'env = { CONCORD_AGENT_KIND = "vibe" }',
      'weird."key" = 1',
      '',
    ].join('\n');
    expect(upsertVibeMcpConfig(src)).toBe(src);
  });

  it('treats a block whose key carries TOML escapes as user-owned', () => {
    // A bare-key shape the scanner cannot capture must never cost the entry.
    const src = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      'env = { CONCORD_AGENT_KIND = "vibe" }',
      '"enabled".extra = true',
      '',
    ].join('\n');
    expect(upsertVibeMcpConfig(src)).toBe(src);
  });

  it('still owns and rewrites the exact shape Concord writes', () => {
    const src = [
      '[[mcp_servers]]',
      'name = "concord"',
      'transport = "stdio"',
      'command = "concord-mcp"',
      'env = { CONCORD_AGENT_KIND = "vibe" }',
      '',
    ].join('\n');
    const next = upsertVibeMcpConfig(src);
    expect(next).toContain('command = "concord-mcp"');
    expect(next.match(/\[\[mcp_servers\]\]/gu)).toHaveLength(1);
  });
});
