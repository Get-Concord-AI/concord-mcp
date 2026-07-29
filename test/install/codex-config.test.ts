import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CODEX_SECTION_HEADER,
  codexConfigFile,
  installCodexMcpConfig,
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
