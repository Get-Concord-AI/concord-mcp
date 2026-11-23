import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readUserConfig, writeUserConfig } from '../../src/config/user-config.js';
import { resolveGlobalChoice, runSetup } from '../../src/cli/commands/setup.js';
import { BLOCK_START, removeBlock, upsertBlock } from '../../src/install/block.js';
import { applyGlobalMode } from '../../src/install/global-mode.js';
import { writeFakeCommand, writeFakeVersion } from '../helpers/fake-command.js';

const CLAUDE_LOGGING_CALLS = `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(join(process.env.HOME ?? '', 'claude-calls'), process.argv.slice(2).join(' ') + '\\n');
`;

const DEVIN_VERSION_SCRIPT = `console.log('Devin CLI v3000.3.0');\n`;

const HARNESSES = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'goose', 'agy'] as const;

/** A home with fake harness executables; `claude` logs the arguments it gets. */
function machine(harnesses: readonly string[] = HARNESSES): NodeJS.ProcessEnv & { HOME: string } {
  const home = mkdtempSync(join(tmpdir(), 'concord-global-home-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  for (const name of harnesses) {
    writeFakeCommand(
      bin,
      name,
      name === 'claude' ? CLAUDE_LOGGING_CALLS : name === 'devin' ? DEVIN_VERSION_SCRIPT : '',
    );
  }
  return { HOME: home, PATH: bin, CODEX_HOME: join(home, '.codex') };
}

const read = (path: string): string => readFileSync(path, 'utf8');

describe('applyGlobalMode', () => {
  it('preserves DeepSeek user instructions under DSH_HOME when global mode changes', () => {
    const env = machine(['dsh']);
    env['DSH_HOME'] = join(env.HOME, 'custom-dsh');
    const path = join(env['DSH_HOME'], 'AGENTS.md');
    mkdirSync(env['DSH_HOME']);
    writeFileSync(path, '# My DeepSeek instructions\n');
    applyGlobalMode(env, true);
    const installed = read(path);
    expect(installed).toContain('# My DeepSeek instructions');
    expect(installed).toContain('start_work');
    applyGlobalMode(env, true);
    expect(read(path)).toBe(installed);
    applyGlobalMode(env, false);
    expect(read(path)).toBe('# My DeepSeek instructions\n');
  });
  it('installs and removes Devin user MCP config and instructions', () => {
    const env = machine(['devin']);
    const on = applyGlobalMode(env, true);
    expect(on.registrations).toEqual(['devin']);
    expect(read(join(env.HOME, '.config', 'devin', 'mcp_config.json'))).toContain('concord-mcp');
    expect(read(join(env.HOME, '.config', 'devin', 'AGENTS.md'))).toContain('start_work');
    const off = applyGlobalMode(env, false, { registrations: on.registrations });
    expect(off.registrations).toEqual([]);
    expect(existsSync(join(env.HOME, '.config', 'devin', 'AGENTS.md'))).toBe(false);
    expect(read(join(env.HOME, '.config', 'devin', 'mcp_config.json'))).not.toContain(
      'concord-mcp',
    );
    const userConfig = read(join(env.HOME, '.config', 'devin', 'config.json'));
    expect(userConfig).not.toContain('concord hook devin-');
    expect(userConfig).not.toContain('"hooks"');
  });

  it('adds global Devin hooks while preserving existing user config, then removes Concord hooks', () => {
    const env = machine(['devin']);
    const config = join(env.HOME, '.config', 'devin', 'config.json');
    mkdirSync(join(env.HOME, '.config', 'devin'), { recursive: true });
    writeFileSync(config, '{\n  // User setting\n  "theme_mode": "dark"\n}\n');

    const on = applyGlobalMode(env, true);
    const installed = read(config);
    expect(installed).toContain('// User setting');
    expect(installed).toContain('"theme_mode": "dark"');
    expect(installed).toContain('concord hook devin-session-start');
    expect(installed).toContain('concord hook devin-user-prompt-submit');
    expect(installed).toContain('concord hook devin-session-end');

    applyGlobalMode(env, false, { registrations: on.registrations });
    const removed = read(config);
    expect(removed).toContain('// User setting');
    expect(removed).toContain('"theme_mode": "dark"');
    expect(removed).not.toContain('"hooks"');
    expect(removed).not.toContain('concord hook devin-');
  });

  it('does not register the dedicated Devin MCP file on an older CLI', () => {
    const env = machine(['devin']);
    writeFakeVersion(join(env.HOME, 'bin'), 'devin', 'Devin CLI v3000.2.9');

    const report = applyGlobalMode(env, true);

    expect(report.registrations).toEqual([]);
    expect(existsSync(join(env.HOME, '.config', 'devin', 'mcp_config.json'))).toBe(false);
  });

  it('registers and instructs each installed harness, then removes only its own additions', () => {
    const env = machine();
    mkdirSync(join(env.HOME, '.claude'));
    writeFileSync(join(env.HOME, '.claude', 'CLAUDE.md'), '# My rules\n');

    const on = applyGlobalMode(env, true);

    expect(on.warnings).toEqual([]);
    expect(on.registrations).toEqual(['antigravity', 'claude', 'cursor', 'gemini', 'grok']);
    expect(read(join(env.HOME, '.claude', 'CLAUDE.md'))).toMatch(/^# My rules\n\n<!-- concord/u);
    for (const path of [
      join(env.HOME, '.codex', 'AGENTS.md'),
      join(env.HOME, '.gemini', 'GEMINI.md'),
      join(env.HOME, '.gemini', 'config', 'rules', 'concord.md'),
      join(env.HOME, '.config', 'goose', '.goosehints'),
    ]) {
      expect(read(path)).toContain('do not run `concord setup` yourself');
    }
    expect(read(join(env.HOME, '.gemini', 'config', 'rules', 'concord.md'))).toContain(
      'trigger: always_on',
    );
    for (const path of [
      join(env.HOME, '.gemini', 'settings.json'),
      join(env.HOME, '.gemini', 'config', 'mcp_config.json'),
      join(env.HOME, '.grok', 'config.toml'),
      join(env.HOME, '.cursor', 'mcp.json'),
    ]) {
      expect(read(path)).toMatch(/concord-mcp/u);
      expect(read(path)).not.toContain('CONCORD_REPO_ROOT');
    }
    expect(read(join(env.HOME, 'claude-calls')).trim()).toBe(
      'mcp add --scope user concord concord-mcp',
    );
    expect(applyGlobalMode(env, true, on).written).toEqual([
      'claude mcp add --scope user concord concord-mcp',
    ]);

    const off = applyGlobalMode(env, false, { registrations: on.registrations });

    expect(off.warnings).toEqual([]);
    expect(off.registrations).toEqual([]);
    expect(read(join(env.HOME, '.claude', 'CLAUDE.md'))).toBe('# My rules\n');
    expect(existsSync(join(env.HOME, '.codex', 'AGENTS.md'))).toBe(false);
    expect(read(join(env.HOME, '.gemini', 'settings.json'))).not.toContain('concord-mcp');
    expect(existsSync(join(env.HOME, '.gemini', 'config', 'rules', 'concord.md'))).toBe(false);
    expect(read(join(env.HOME, '.gemini', 'config', 'mcp_config.json'))).not.toContain(
      'concord-mcp',
    );
    expect(existsSync(join(env.HOME, '.grok', 'config.toml'))).toBe(false);
    expect(read(join(env.HOME, '.cursor', 'mcp.json'))).not.toContain('concord-mcp');
    expect(read(join(env.HOME, 'claude-calls'))).toContain('mcp remove --scope user concord');
  });

  it('writes only instructions under --no-mcp, and only for installed harnesses', () => {
    const env = machine(['claude', 'codex']);
    const report = applyGlobalMode(env, true, { mcp: false });
    expect(report.written).toEqual([
      join(env.HOME, '.claude', 'CLAUDE.md'),
      join(env.HOME, '.codex', 'AGENTS.md'),
    ]);
    expect(existsSync(join(env.HOME, '.gemini'))).toBe(false);
    expect(existsSync(join(env.HOME, 'claude-calls'))).toBe(false);
  });

  it('warns when Claude Code cannot remove the server, but not when it is already gone', () => {
    const env = machine([]);
    const claude = (output: string): void => {
      writeFakeCommand(
        join(env.HOME, 'bin'),
        'claude',
        `console.log(${JSON.stringify(output)});\nprocess.exitCode = 1;\n`,
      );
    };
    const registrations = ['claude'];
    claude('No MCP server named "concord" in user scope');
    expect(applyGlobalMode(env, false, { registrations }).warnings).toEqual([]);
    claude('could not write config');
    expect(applyGlobalMode(env, false, { registrations }).warnings).toEqual([
      'claude mcp remove --scope user concord: could not write config',
    ]);
  });
});

describe('registrations the user made', () => {
  it('are neither replaced when global mode turns on nor removed when it is declined', () => {
    const env = machine();
    const gemini = join(env.HOME, '.gemini', 'settings.json');
    const grok = join(env.HOME, '.grok', 'config.toml');
    const cursor = join(env.HOME, '.cursor', 'mcp.json');
    const antigravity = join(env.HOME, '.gemini', 'config', 'mcp_config.json');
    for (const dir of ['.gemini', '.grok', '.cursor', join('.gemini', 'config')]) {
      mkdirSync(join(env.HOME, dir), { recursive: true });
    }
    writeFileSync(cursor, '{"mcpServers":{"concord":{"command":"my-concord"}}}\n');
    writeFileSync(gemini, '{"mcpServers":{"concord":{"command":"my-concord","args":["--x"]}}}\n');
    writeFileSync(grok, '[mcp_servers]\nconcord = { command = "my-concord" }\n');
    writeFileSync(antigravity, '{"mcpServers":{"concord":{"command":"my-concord"}}}\n');
    const before = [read(gemini), read(grok), read(cursor), read(antigravity)];

    expect(applyGlobalMode(env, false).written).toEqual([]);
    expect(existsSync(join(env.HOME, 'claude-calls'))).toBe(false);

    const on = applyGlobalMode(env, true);
    expect([read(gemini), read(grok), read(cursor), read(antigravity)]).toEqual(before);
    expect(on.registrations).toEqual(['claude']);

    applyGlobalMode(env, false, { registrations: on.registrations });
    expect([read(gemini), read(grok), read(cursor), read(antigravity)]).toEqual(before);
  });

  it('installs Antigravity global rules and MCP config when detected via ANTIGRAVITY_AGENT without agy executable', () => {
    const env = machine([]);
    const customEnv = { ...env, ANTIGRAVITY_AGENT: '1' };
    const report = applyGlobalMode(customEnv, true);

    expect(report.registrations).toEqual(['antigravity']);
    const rulesPath = join(customEnv.HOME, '.gemini', 'config', 'rules', 'concord.md');
    const mcpPath = join(customEnv.HOME, '.gemini', 'config', 'mcp_config.json');
    expect(existsSync(rulesPath)).toBe(true);
    expect(read(rulesPath)).toContain('trigger: always_on');
    expect(existsSync(mcpPath)).toBe(true);
    expect(read(mcpPath)).toContain('concord-mcp');

    const off = applyGlobalMode(customEnv, false, { registrations: report.registrations });
    expect(off.registrations).toEqual([]);
    expect(existsSync(rulesPath)).toBe(false);
    expect(read(mcpPath)).not.toContain('concord-mcp');
  });
});

describe('a Grok config Concord cannot extend', () => {
  it('is left as it is, with a warning', () => {
    const env = machine(['grok']);
    const grok = join(env.HOME, '.grok', 'config.toml');
    mkdirSync(join(env.HOME, '.grok'));
    writeFileSync(grok, 'mcp_servers = { other = { command = "other" } }\n');
    const report = applyGlobalMode(env, true);
    expect(read(grok)).toBe('mcp_servers = { other = { command = "other" } }\n');
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/inline table/u);
    expect(report.warnings[0]?.startsWith(`${grok} `)).toBe(true);
    expect(report.warnings[0]).not.toContain(` ${join('.grok', 'config.toml')} `);
    expect(report.registrations).toEqual([]);
  });

  it('is left as it is, without a warning, when it registers Concord inline', () => {
    const env = machine(['grok']);
    const grok = join(env.HOME, '.grok', 'config.toml');
    mkdirSync(join(env.HOME, '.grok'));
    const inline = 'mcp_servers = { concord = { command = "my-concord" } }\n';
    writeFileSync(grok, inline);
    const report = applyGlobalMode(env, true);
    expect(read(grok)).toBe(inline);
    expect(report.warnings).toEqual([]);
    expect(report.registrations).toEqual([]);
  });

  it('keeps a multi-line string that quotes a Concord table when turned off', () => {
    const env = machine(['grok']);
    const grok = join(env.HOME, '.grok', 'config.toml');
    mkdirSync(join(env.HOME, '.grok'));
    const own = 'prompt = """\n[mcp_servers.concord]\nnot = "a table"\n"""\nafter = true\n';
    writeFileSync(grok, own);
    const on = applyGlobalMode(env, true);
    expect(on.registrations).toEqual(['grok']);
    applyGlobalMode(env, false, { registrations: on.registrations });
    expect(read(grok)).toBe(own);
  });
});

describe('removeBlock', () => {
  it('restores the text around the block exactly', () => {
    for (const original of ['# Rules\n', 'Line with a break  \n', 'A\n\n\nB\n', '']) {
      expect(removeBlock(upsertBlock(original, 'block'))).toBe(original);
    }
    // `abc` and `abc\n` get the same block, so removal cannot tell them apart.
    expect(removeBlock(upsertBlock('abc', 'block'))).toBe('abc\n');
    const edited = `${upsertBlock('A\n', 'block')}\nAdded later  \n`;
    expect(removeBlock(edited)).toBe('A\n\nAdded later  \n');
  });
});

describe('resolveGlobalChoice', () => {
  const ask = (): Promise<boolean> => Promise.resolve(true);

  it('asks once, interactively, and otherwise follows the saved choice', async () => {
    const env = machine([]);
    expect(await resolveGlobalChoice({ env, interactive: false, ask })).toBeUndefined();
    expect(await resolveGlobalChoice({ env, interactive: true, ask })).toBe(true);

    writeUserConfig(env, { globalMode: true });
    expect(await resolveGlobalChoice({ env, interactive: false })).toBe(true);
    writeUserConfig(env, { globalMode: false });
    expect(await resolveGlobalChoice({ env, interactive: true, ask })).toBeUndefined();
    expect(await resolveGlobalChoice({ env, interactive: false, flag: true })).toBe(true);
  });
});

describe('runSetup with global mode', () => {
  const REPO_FILES = [
    'CLAUDE.md',
    'AGENTS.md',
    join('.codex', 'concord.md'),
    join('.cursor', 'rules', 'concord.mdc'),
    join('.github', 'copilot-instructions.md'),
    join('.agents', 'rules', 'concord.md'),
    '.mcp.json',
    join('.cursor', 'mcp.json'),
    join('.agents', 'mcp_config.json'),
    join('.agents', 'hooks.json'),
    join('.github', 'mcp.json'),
    join('.gemini', 'settings.json'),
    join('.grok', 'config.toml'),
    join('.devin', 'hooks.v1.json'),
    join('.devin', 'mcp_config.json'),
  ];

  function repository(): string {
    const repo = mkdtempSync(join(tmpdir(), 'concord-global-repo-'));
    mkdirSync(join(repo, '.git'));
    return repo;
  }

  const present = (repo: string): string[] =>
    REPO_FILES.filter((relPath) => existsSync(join(repo, relPath)));

  it('saves the choice and sets the repository up locally without writing repository files', () => {
    const env = machine([]);
    const repo = repository();

    const result = runSetup(repo, {
      env: { ...env, CONCORD_REPO_ROOT: repo },
      global: true,
    });

    expect(readUserConfig(env)).toEqual({ globalMode: true, globalRegistrations: [] });
    expect(result.globalMode).toEqual({ written: [], warnings: [], registrations: [] });
    expect(result.repoFilesSkipped).toBe(true);
    expect(existsSync(join(repo, '.concord', 'concord.db'))).toBe(true);
    expect(present(repo)).toEqual([]);
    expect(result.written.filter((path) => !path.startsWith(env.HOME))).toEqual([]);
  });

  it('skips the repository files when global mode was saved earlier', () => {
    const env = machine([]);
    writeUserConfig(env, { globalMode: true });
    const repo = repository();

    const result = runSetup(repo, { env: { ...env, CONCORD_REPO_ROOT: repo } });

    expect(result.repoFilesSkipped).toBe(true);
    expect(present(repo)).toEqual([]);
  });

  it('skips the repository files with --no-mcp too, and leaves existing ones alone', () => {
    const env = machine([]);
    const repo = repository();
    const existing = upsertBlock('# Mine\n', 'old instructions');
    writeFileSync(join(repo, 'CLAUDE.md'), existing);

    runSetup(repo, { env: { ...env, CONCORD_REPO_ROOT: repo }, mcp: false, global: true });

    expect(read(join(repo, 'CLAUDE.md'))).toBe(existing);
    expect(present(repo)).toEqual(['CLAUDE.md']);
  });

  it('writes the repository files when asked with repoFiles', () => {
    const env = machine([]);
    const repo = repository();

    const result = runSetup(repo, {
      env: { ...env, CONCORD_REPO_ROOT: repo },
      global: true,
      repoFiles: true,
    });

    expect(result.repoFilesSkipped).toBe(false);
    expect(present(repo)).toEqual(REPO_FILES);
    expect(read(join(repo, 'CLAUDE.md'))).toContain(BLOCK_START);
  });

  it('writes the repository files when global mode is off or was never chosen', () => {
    const env = machine([]);
    const turnedOff = repository();
    runSetup(turnedOff, { env: { ...env, CONCORD_REPO_ROOT: turnedOff }, global: false });
    expect(present(turnedOff)).toEqual(REPO_FILES);

    const neverChosen = repository();
    const result = runSetup(neverChosen, {
      env: { ...machine([]), CONCORD_REPO_ROOT: neverChosen },
    });
    expect(result.repoFilesSkipped).toBe(false);
    expect(present(neverChosen)).toEqual(REPO_FILES);
  });

  it('judges Gemini by the settings global mode writes, so a first --require-adapters run passes', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-global-home-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFakeVersion(bin, 'gemini', '0.55.1');
    const env = { HOME: home, PATH: bin, CODEX_HOME: join(home, '.codex') };
    const repo = repository();

    const result = runSetup(repo, {
      env: { ...env, CONCORD_REPO_ROOT: repo },
      global: true,
      adapters: true,
      requireAdapters: true,
    });

    expect(read(join(home, '.gemini', 'settings.json'))).toContain('modelSteering');
    expect(result.adapters.find((entry) => entry.harness === 'gemini')?.status).toBe('installed');
    expect(result.globalMode?.registrations).toContain('gemini');
    expect(present(repo)).toEqual([]);
  });

  it('writes the repository files when saved global mode is turned off in the same run', () => {
    const env = machine([]);
    writeUserConfig(env, { globalMode: true });
    const repo = repository();

    runSetup(repo, { env: { ...env, CONCORD_REPO_ROOT: repo }, global: false });

    expect(present(repo)).toEqual(REPO_FILES);
  });
});
