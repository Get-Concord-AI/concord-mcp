import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CODEX_SECTION_HEADER,
  codexConfigFile,
  installCodexMcpConfig,
  installCodexHooks,
  uninstallCodexConfig,
  upsertCodexMcpServer,
} from '../../src/install/codex-config.js';
import { CONCORD_SERVER_COMMAND } from '../../src/install/mcp-config.js';

describe('codexConfigFile', () => {
  it('honors CODEX_HOME', () => {
    const home = join(tmpdir(), 'codex-home');
    expect(codexConfigFile({ CODEX_HOME: home })).toBe(join(home, 'config.toml'));
  });

  it('falls back to ~/.codex when CODEX_HOME is unset or blank', () => {
    const expected = join(homedir(), '.codex', 'config.toml');
    expect(codexConfigFile({})).toBe(expected);
    expect(codexConfigFile({ CODEX_HOME: '  ' })).toBe(expected);
  });
});

describe('upsertCodexMcpServer', () => {
  it('writes the table into an empty config', () => {
    const out = upsertCodexMcpServer(undefined);
    expect(out).toContain(CODEX_SECTION_HEADER);
    expect(out).toContain(`command = "${CONCORD_SERVER_COMMAND}"`);
  });

  it('is idempotent: re-running produces identical output', () => {
    const once = upsertCodexMcpServer(undefined);
    expect(upsertCodexMcpServer(once)).toBe(once);
  });

  it('preserves unrelated tables and their comments', () => {
    const existing = [
      '# my codex config',
      'model = "gpt-5"',
      '',
      '[mcp_servers.other]',
      'command = "other-server"',
      '',
    ].join('\n');
    const out = upsertCodexMcpServer(existing);

    expect(out).toContain('# my codex config');
    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain('[mcp_servers.other]');
    expect(out).toContain('other-server');
    expect(out).toContain(CODEX_SECTION_HEADER);
    expect(upsertCodexMcpServer(out)).toBe(out);
  });

  it('replaces a stale concord table in place without duplicating it', () => {
    const existing = [
      '[mcp_servers.concord]',
      'command = "old-binary"',
      '',
      '[other]',
      'key = 1',
      '',
    ].join('\n');
    const out = upsertCodexMcpServer(existing);

    expect(out).not.toContain('old-binary');
    expect(out).toContain(`command = "${CONCORD_SERVER_COMMAND}"`);
    expect(out.split(CODEX_SECTION_HEADER).length - 1).toBe(1);
    expect(out).toContain('[other]');
    expect(out).toContain('key = 1');
  });

  it('keeps a nested concord subtable, which is a table in its own right', () => {
    const existing = [
      '[mcp_servers.concord]',
      'command = "old-binary"',
      '',
      '[mcp_servers.concord.env]',
      'CONCORD_REPO_ROOT = "/tmp/repo"',
      '',
    ].join('\n');
    const out = upsertCodexMcpServer(existing);

    expect(out).not.toContain('old-binary');
    expect(out).toContain('[mcp_servers.concord.env]');
    expect(out).toContain('CONCORD_REPO_ROOT = "/tmp/repo"');
  });

  it('merges the agent kind into an existing env table without defining it twice', () => {
    const existing = [
      '[mcp_servers.concord]',
      'command = "concord-mcp"',
      '',
      '[mcp_servers.concord.env]',
      'CONCORD_REPO_ROOT = "/tmp/repo"',
      '',
      '[other]',
      'key = 1',
      '',
    ].join('\n');
    const out = upsertCodexMcpServer(existing);

    // A dotted env key alongside the subtable would define the same table
    // twice and make the whole file invalid TOML.
    expect(out).not.toMatch(/env\.CONCORD_AGENT_KIND/u);
    expect(out.match(/\[mcp_servers\.concord\.env\]/gu)).toHaveLength(1);
    expect(out).toContain('CONCORD_AGENT_KIND = "codex"');
    expect(out).toContain('CONCORD_REPO_ROOT = "/tmp/repo"');
    expect(out).toContain('[other]');
    expect(out).not.toMatch(/\n\n\n/u);
    expect(upsertCodexMcpServer(out)).toBe(out);
  });

  it('merges the env table even when another table separates it from the server', () => {
    const existing = [
      '[mcp_servers.concord]',
      'command = "concord-mcp"',
      '',
      '[other]',
      'key = 1',
      '',
      '[mcp_servers.concord.env]',
      'CONCORD_REPO_ROOT = "/tmp/repo"',
      '',
    ].join('\n');
    const out = upsertCodexMcpServer(existing);

    expect(out.match(/\[mcp_servers\.concord\.env\]/gu)).toHaveLength(1);
    expect(out).toContain('CONCORD_AGENT_KIND = "codex"');
    expect(out).toContain('CONCORD_REPO_ROOT = "/tmp/repo"');
    expect(out).toContain('[other]');
    expect(out).not.toMatch(/env\.CONCORD_AGENT_KIND/u);
    expect(upsertCodexMcpServer(out)).toBe(out);
  });

  it('replaces a quoted CONCORD_AGENT_KIND key without duplicating it', () => {
    const existing = [
      '[mcp_servers.concord]',
      'command = "concord-mcp"',
      '',
      '[mcp_servers.concord.env]',
      '"CONCORD_AGENT_KIND" = "codex"',
      '',
    ].join('\n');
    const out = upsertCodexMcpServer(existing);

    expect(out.match(/CONCORD_AGENT_KIND/gu)).toHaveLength(1);
    expect(out.match(/\[mcp_servers\.concord\.env\]/gu)).toHaveLength(1);
    expect(upsertCodexMcpServer(out)).toBe(out);
  });
});

describe('installCodexMcpConfig', () => {
  it('writes config.toml under CODEX_HOME and is idempotent', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-codex-'));
    const path = installCodexMcpConfig({ CODEX_HOME: home });

    expect(path).toBe(join(home, 'config.toml'));
    const first = readFileSync(path, 'utf8');
    expect(first).toContain(CONCORD_SERVER_COMMAND);

    installCodexMcpConfig({ CODEX_HOME: home });
    expect(readFileSync(path, 'utf8')).toBe(first);
  });
});

describe('uninstallCodexConfig', () => {
  it('removes only Concord-owned tables and hook fences', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-'));
    const env = { CODEX_HOME: home };
    installCodexMcpConfig(env);
    installCodexHooks(env);
    const path = codexConfigFile(env);
    const withOther = `${readFileSync(path, 'utf8')}\n[other]\nvalue = 1\n`;
    writeFileSync(path, withOther);

    uninstallCodexConfig(env);

    const result = readFileSync(path, 'utf8');
    expect(result).not.toContain(CODEX_SECTION_HEADER);
    expect(result).not.toContain('concord hooks');
    expect(result).toContain('[other]');
  });

  it('removes the managed env table too, leaving no orphaned concord server', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-env-'));
    const env = { CODEX_HOME: home };
    installCodexMcpConfig(env);

    uninstallCodexConfig(env);

    const result = readFileSync(codexConfigFile(env), 'utf8');
    // An orphaned [mcp_servers.concord.env] still defines a `concord` server
    // with no command, which Codex can reject.
    expect(result).not.toContain('[mcp_servers.concord.env]');
    expect(result).not.toContain('CONCORD_AGENT_KIND');
    expect(result.trim()).toBe('');
  });
});
