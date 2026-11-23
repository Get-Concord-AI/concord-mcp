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

  it('is idempotent and replaces a stale concord block in place of duplicating it', () => {
    const once = upsertVibeMcpConfig('theme = "auto"\n');
    const twice = upsertVibeMcpConfig(once);
    expect(twice).toBe(once);
    const stale = once.replace('command = "concord-mcp"', 'command = "old-command"');
    const fixed = upsertVibeMcpConfig(stale);
    expect(fixed.match(/\[\[mcp_servers\]\]/gu)).toHaveLength(1);
    expect(fixed).toContain('command = "concord-mcp"');
    expect(fixed).not.toContain('old-command');
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

  it('converts an empty mcp_servers array instead of breaking the file', () => {
    const next = upsertVibeMcpConfig('mcp_servers = []\n');
    expect(next).not.toContain('mcp_servers = []');
    expect(next).toContain('[[mcp_servers]]');
    expect(hasVibeMcpServer(next)).toBe(true);
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
});
