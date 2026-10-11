import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readUserConfig, writeUserConfig } from '../../src/config/user-config.js';
import { resolveGlobalChoice, runSetup } from '../../src/cli/commands/setup.js';
import { BLOCK_START, removeBlock, upsertBlock } from '../../src/install/block.js';
import { applyGlobalMode } from '../../src/install/global-mode.js';

const HARNESSES = ['claude', 'codex', 'gemini', 'grok', 'goose'] as const;

/** A home with fake harness executables; `claude` logs the arguments it gets. */
function machine(harnesses: readonly string[] = HARNESSES): NodeJS.ProcessEnv & { HOME: string } {
  const home = mkdtempSync(join(tmpdir(), 'concord-global-home-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  for (const name of harnesses) {
    const script =
      name === 'claude' ? '#!/bin/sh\necho "$@" >> "$HOME/claude-calls"\n' : '#!/bin/sh\n';
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  return { HOME: home, PATH: bin, CODEX_HOME: join(home, '.codex') };
}

const read = (path: string): string => readFileSync(path, 'utf8');

describe('applyGlobalMode', () => {
  it('registers and instructs each installed harness, then removes only its own additions', () => {
    const env = machine();
    mkdirSync(join(env.HOME, '.claude'));
    writeFileSync(join(env.HOME, '.claude', 'CLAUDE.md'), '# My rules\n');

    const on = applyGlobalMode(env, true);

    expect(on.warnings).toEqual([]);
    expect(on.registrations).toEqual(['claude', 'gemini', 'grok']);
    expect(read(join(env.HOME, '.claude', 'CLAUDE.md'))).toMatch(/^# My rules\n\n<!-- concord/u);
    for (const path of [
      join(env.HOME, '.codex', 'AGENTS.md'),
      join(env.HOME, '.gemini', 'GEMINI.md'),
      join(env.HOME, '.config', 'goose', '.goosehints'),
    ]) {
      expect(read(path)).toContain('do not run `concord setup` yourself');
    }
    for (const path of [
      join(env.HOME, '.gemini', 'settings.json'),
      join(env.HOME, '.grok', 'config.toml'),
    ]) {
      expect(read(path)).toMatch(/concord-mcp/u);
      expect(read(path)).not.toContain('CONCORD_REPO_ROOT');
    }
    expect(read(join(env.HOME, 'claude-calls'))).toBe('mcp add --scope user concord concord-mcp\n');
    expect(applyGlobalMode(env, true, on).written).toEqual([
      'claude mcp add --scope user concord concord-mcp',
    ]);

    const off = applyGlobalMode(env, false, { registrations: on.registrations });

    expect(off.warnings).toEqual([]);
    expect(off.registrations).toEqual([]);
    expect(read(join(env.HOME, '.claude', 'CLAUDE.md'))).toBe('# My rules\n');
    expect(existsSync(join(env.HOME, '.codex', 'AGENTS.md'))).toBe(false);
    expect(read(join(env.HOME, '.gemini', 'settings.json'))).not.toContain('concord-mcp');
    expect(existsSync(join(env.HOME, '.grok', 'config.toml'))).toBe(false);
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
      writeFileSync(join(env.HOME, 'bin', 'claude'), `#!/bin/sh\necho '${output}'\nexit 1\n`);
      chmodSync(join(env.HOME, 'bin', 'claude'), 0o755);
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
    for (const dir of ['.gemini', '.grok']) mkdirSync(join(env.HOME, dir));
    writeFileSync(gemini, '{"mcpServers":{"concord":{"command":"my-concord","args":["--x"]}}}\n');
    writeFileSync(grok, '[mcp_servers]\nconcord = { command = "my-concord" }\n');
    const before = [read(gemini), read(grok)];

    expect(applyGlobalMode(env, false).written).toEqual([]);
    expect(existsSync(join(env.HOME, 'claude-calls'))).toBe(false);

    const on = applyGlobalMode(env, true);
    expect([read(gemini), read(grok)]).toEqual(before);
    expect(on.registrations).toEqual(['claude']);

    applyGlobalMode(env, false, { registrations: on.registrations });
    expect([read(gemini), read(grok)]).toEqual(before);
  });
});

describe('removeBlock', () => {
  it('restores the text around the block exactly', () => {
    for (const original of ['# Rules\n', 'Line with a break  \n', 'A\n\n\nB\n', '']) {
      expect(removeBlock(upsertBlock(original, 'block'))).toBe(original);
    }
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
  it('saves the choice and still sets the repository up locally', () => {
    const env = machine([]);
    const repo = mkdtempSync(join(tmpdir(), 'concord-global-repo-'));
    mkdirSync(join(repo, '.git'));

    const result = runSetup(repo, {
      env: { ...env, CONCORD_REPO_ROOT: repo },
      mcp: false,
      global: true,
    });

    expect(readUserConfig(env)).toEqual({ globalMode: true, globalRegistrations: [] });
    expect(result.globalMode).toEqual({ written: [], warnings: [], registrations: [] });
    expect(existsSync(join(repo, '.concord', 'concord.db'))).toBe(true);
    expect(read(join(repo, 'CLAUDE.md'))).toContain(BLOCK_START);
  });
});
