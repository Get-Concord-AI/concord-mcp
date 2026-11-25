import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CODEX_SECTION_HEADER,
  codexConfigFile,
  installCodexMcpConfig,
  installCodexHooks,
  removeCodexMcpServer,
  uninstallCodexConfig,
  upsertCodexHooks,
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

  it('keeps the comment lines that introduce the next table', () => {
    // Rewriting our table used to erase the hooks begin marker below it.
    const existing = [
      '[mcp_servers.concord]',
      'command = "old-binary"',
      '',
      '# >>> concord hooks >>>',
      '# a note about the table below',
      '[[hooks.SessionStart]]',
      '',
    ].join('\n');
    const out = upsertCodexMcpServer(existing);

    expect(out).not.toContain('old-binary');
    expect(out).toContain(
      '# >>> concord hooks >>>\n# a note about the table below\n[[hooks.SessionStart]]',
    );
    expect(upsertCodexMcpServer(out)).toBe(out);
  });

  it('keeps a CRLF file CRLF', () => {
    const out = upsertCodexMcpServer('model = "o3"\r\n');

    expect(out).toBe(
      `model = "o3"\r\n\r\n${CODEX_SECTION_HEADER}\r\ncommand = "${CONCORD_SERVER_COMMAND}"\r\n`,
    );
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

  it('removes Codex-written tool approval subtables so no transport-less server remains', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-'));
    const env = { CODEX_HOME: home };
    installCodexMcpConfig(env);
    const path = codexConfigFile(env);
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8')}
[mcp_servers.concord.tools.start_work]
approval_mode = "approve"

[mcp_servers.concord.env]
CONCORD_REPO_ROOT = "/repo"

[mcp_servers.other]
command = "other"

[mcp_servers.other.tools.run]
approval_mode = "approve"
`,
    );

    uninstallCodexConfig(env);

    const result = readFileSync(path, 'utf8');
    expect(result).not.toContain('mcp_servers.concord');
    expect(result).toBe(
      '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.other.tools.run]\napproval_mode = "approve"\n',
    );
  });

  it('removes drifted hooks and every stray marker', () => {
    const env = { CODEX_HOME: mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-')) };
    const block = upsertCodexHooks(undefined).trimEnd();
    const strayBegin = block.split('\n').slice(0, 3).join('\n');
    const trust = '[hooks.state."x:stop:0:0"]\ntrusted_hash = "sha256:abc"';
    const settings = '[tui]\nalt_screen = true';
    const drifted = [
      `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"`,
      `${trust}\n# <<< concord hooks <<<`,
      settings,
      strayBegin,
      block,
    ].join('\n\n');
    writeFileSync(codexConfigFile(env), `${drifted}\n`);

    uninstallCodexConfig(env);

    const result = readFileSync(codexConfigFile(env), 'utf8');
    expect(result).not.toContain('concord inbox');
    expect(result).not.toContain('concord hooks');
    expect(result).not.toContain(CODEX_SECTION_HEADER);
    expect(result).toContain(trust);
    expect(result).toContain(settings);
  });

  it('leaves blank lines inside multi-line strings alone', () => {
    const env = { CODEX_HOME: mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-')) };
    const server = `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"`;
    const user = 'developer_instructions = """\nfirst\n\n\nsecond\n"""';
    writeFileSync(codexConfigFile(env), `${user}\n\n${server}\n\n${upsertCodexHooks(undefined)}`);

    uninstallCodexConfig(env);

    const result = readFileSync(codexConfigFile(env), 'utf8');
    expect(result).toContain(user);
    expect(result).not.toContain('concord');
  });

  it("keeps a user's own concord inbox hook", () => {
    const env = { CODEX_HOME: mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-')) };
    const user = [
      '[[hooks.Stop]]',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "concord inbox watch --mine"',
    ].join('\n');
    writeFileSync(codexConfigFile(env), `${user}\n\n${upsertCodexHooks(undefined)}`);

    uninstallCodexConfig(env);

    const result = readFileSync(codexConfigFile(env), 'utf8');
    expect(result).toContain(user);
    expect(result).not.toContain('--from-hook');
  });

  it("keeps a user's entry in its own group", () => {
    const env = { CODEX_HOME: mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-')) };
    const userEntry = '[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "my-hook"';
    const concordEntry =
      '[[hooks.SessionStart.hooks]]\ntype = "command"\n' +
      'command = "concord inbox register --from-hook --provider codex"';
    writeFileSync(
      codexConfigFile(env),
      `[[hooks.SessionStart]]\n${concordEntry}\n\n${userEntry}\n`,
    );

    uninstallCodexConfig(env);

    expect(readFileSync(codexConfigFile(env), 'utf8')).toBe(
      `[[hooks.SessionStart]]\n\n${userEntry}\n`,
    );
  });

  it('keeps a CRLF file CRLF', () => {
    const env = { CODEX_HOME: mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-')) };
    const server = `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"`;
    const config = `model = "o3"\n\n${server}\n\n${upsertCodexHooks(undefined)}`;
    writeFileSync(codexConfigFile(env), config.replaceAll('\n', '\r\n'));

    uninstallCodexConfig(env);

    expect(readFileSync(codexConfigFile(env), 'utf8')).toBe('model = "o3"\r\n');
  });

  it('leaves markers and hook headers inside a multi-line string alone', () => {
    const env = { CODEX_HOME: mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-')) };
    const user = `notes = """\n${upsertCodexHooks(undefined).trimEnd()}\n"""`;
    writeFileSync(codexConfigFile(env), `${user}\n`);

    uninstallCodexConfig(env);

    expect(readFileSync(codexConfigFile(env), 'utf8')).toBe(`${user}\n`);
  });

  it('keeps the lines after the end marker', () => {
    const env = { CODEX_HOME: mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-')) };
    const server = `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"`;
    const block = upsertCodexHooks(undefined).trimEnd();
    writeFileSync(codexConfigFile(env), `${server}\n\n${block}\nmodel = "o3"\n`);

    uninstallCodexConfig(env);

    expect(readFileSync(codexConfigFile(env), 'utf8')).toBe('model = "o3"\n');
  });

  it('keeps a comment above the table after the server table', () => {
    const env = { CODEX_HOME: mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-')) };
    const server = `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"`;
    const tui = '# my terminal settings\n[tui]\nalt_screen = true\n';
    writeFileSync(codexConfigFile(env), `${server}\n\n${tui}`);

    uninstallCodexConfig(env);

    expect(readFileSync(codexConfigFile(env), 'utf8')).toBe(tui);
  });

  it('removes a hook written with quoted keys', () => {
    const env = { CODEX_HOME: mkdtempSync(join(tmpdir(), 'concord-codex-uninstall-')) };
    const quoted = upsertCodexHooks(undefined)
      .replaceAll('type = "command"', '"type" = "command"')
      .replaceAll('command = "concord', '"command" = "concord');
    writeFileSync(codexConfigFile(env), `model = "o3"\n\n${quoted}`);

    uninstallCodexConfig(env);

    expect(readFileSync(codexConfigFile(env), 'utf8')).toBe('model = "o3"\n');
  });
});

describe('removeCodexMcpServer', () => {
  it('matches quoted and spaced spellings and stops at array-of-tables headers', () => {
    const source = [
      '[ mcp_servers . "concord" ]',
      'command = "concord-mcp"',
      '',
      "[mcp_servers.'concord'.tools.update_work]",
      'approval_mode = "approve"',
      '',
      '[[hooks.Stop]]',
      'type = "command"',
      '',
    ].join('\n');

    expect(removeCodexMcpServer(source)).toBe('[[hooks.Stop]]\ntype = "command"\n');
  });

  it('keeps a table whose name only starts with concord', () => {
    const source = '[mcp_servers.concord-cloud]\nurl = "https://example.test"\n';
    expect(removeCodexMcpServer(source)).toBe(source);
  });

  it('ignores header-like lines inside multi-line strings', () => {
    const source = '[notes]\ntext = """\n[mcp_servers.concord]\n"""\n';
    expect(removeCodexMcpServer(source)).toBe(source);
  });
});
