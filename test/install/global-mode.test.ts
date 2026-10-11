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
import { BLOCK_START } from '../../src/install/block.js';
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
  it('registers Concord and writes instructions for each installed harness', () => {
    const env = machine();
    mkdirSync(join(env.HOME, '.claude'));
    writeFileSync(join(env.HOME, '.claude', 'CLAUDE.md'), '# My rules\n');

    const report = applyGlobalMode(env, true);

    expect(report.warnings).toEqual([]);
    expect(read(join(env.HOME, '.claude', 'CLAUDE.md'))).toMatch(/^# My rules\n\n<!-- concord/u);
    for (const path of [
      join(env.HOME, '.codex', 'AGENTS.md'),
      join(env.HOME, '.gemini', 'GEMINI.md'),
      join(env.HOME, '.config', 'goose', '.goosehints'),
    ]) {
      expect(read(path)).toContain('do not run `concord setup` yourself');
    }
    const gemini: unknown = JSON.parse(read(join(env.HOME, '.gemini', 'settings.json')));
    expect(gemini).toMatchObject({ mcpServers: { concord: { command: 'concord-mcp' } } });
    expect(read(join(env.HOME, '.gemini', 'settings.json'))).not.toContain('CONCORD_REPO_ROOT');
    expect(read(join(env.HOME, '.grok', 'config.toml'))).toContain('[mcp_servers.concord]');
    expect(read(join(env.HOME, '.grok', 'config.toml'))).not.toContain('CONCORD_REPO_ROOT');
    expect(read(join(env.HOME, 'claude-calls'))).toBe('mcp add --scope user concord concord-mcp\n');

    // Applying again changes no file.
    expect(applyGlobalMode(env, true).written).toEqual([
      'claude mcp add --scope user concord concord-mcp',
    ]);
  });

  it('writes nothing for a harness that is not installed', () => {
    const env = machine(['codex']);
    applyGlobalMode(env, true);
    expect(existsSync(join(env.HOME, '.claude'))).toBe(false);
    expect(existsSync(join(env.HOME, '.gemini'))).toBe(false);
    expect(existsSync(join(env.HOME, '.codex', 'AGENTS.md'))).toBe(true);
  });

  it('removes only what it added when turned off', () => {
    const env = machine();
    mkdirSync(join(env.HOME, '.claude'));
    writeFileSync(join(env.HOME, '.claude', 'CLAUDE.md'), '# My rules\n');
    applyGlobalMode(env, true);

    const report = applyGlobalMode(env, false);

    expect(report.warnings).toEqual([]);
    expect(read(join(env.HOME, '.claude', 'CLAUDE.md'))).toBe('# My rules\n');
    expect(existsSync(join(env.HOME, '.codex', 'AGENTS.md'))).toBe(false);
    expect(read(join(env.HOME, '.gemini', 'settings.json'))).not.toContain('concord-mcp');
    expect(existsSync(join(env.HOME, '.grok', 'config.toml'))).toBe(false);
    expect(read(join(env.HOME, 'claude-calls'))).toContain('mcp remove --scope user concord');
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

    expect(readUserConfig(env)).toEqual({ globalMode: true });
    expect(result.globalMode).toEqual({ written: [], warnings: [] });
    expect(existsSync(join(repo, '.concord', 'concord.db'))).toBe(true);
    expect(read(join(repo, 'CLAUDE.md'))).toContain(BLOCK_START);
  });
});
