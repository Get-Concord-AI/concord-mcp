import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { installGlobalInstructions } from '../../src/install/global-instructions.js';
import { BLOCK_START, upsertBlock } from '../../src/install/block.js';

const homes: string[] = [];
function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'concord-global-instructions-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('installGlobalInstructions', () => {
  it('installs all five personal defaults and is idempotent without losing user content', () => {
    const home = temporaryHome();
    const paths = installGlobalInstructions({ HOME: home });
    expect(paths).toEqual([
      join(home, '.codex', 'AGENTS.md'),
      join(home, '.claude', 'CLAUDE.md'),
      join(home, '.cursor', 'rules', 'concord.mdc'),
      join(home, '.gemini', 'GEMINI.md'),
      join(home, '.grok', 'AGENTS.md'),
    ]);
    for (const path of paths) {
      const installed = readFileSync(path, 'utf8');
      expect(installed).toContain('concord setup --no-global-instructions');
      expect(installed).toContain('opt out of Concord');
      writeFileSync(path, `${installed}\nKeep my personal instructions.\n`);
    }
    const before = paths.map((path) => readFileSync(path, 'utf8'));
    installGlobalInstructions({ HOME: home });
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
    expect(readFileSync(join(home, '.cursor', 'rules', 'concord.mdc'), 'utf8')).toContain(
      'alwaysApply: true',
    );
  });

  it('honors home overrides and updates the active Codex override file', () => {
    const home = temporaryHome();
    const codex = join(home, 'custom-codex');
    const override = join(codex, 'AGENTS.override.md');
    mkdirSync(dirname(override), { recursive: true });
    writeFileSync(override, upsertBlock('My preferences.\n', 'Old Concord instructions'));
    writeFileSync(join(codex, 'AGENTS.md'), 'Inactive instructions.\n');
    const paths = installGlobalInstructions({
      USERPROFILE: home,
      CODEX_HOME: codex,
      CLAUDE_CONFIG_DIR: join(home, 'custom-claude'),
      GROK_HOME: join(home, 'custom-grok'),
    });
    expect(paths).toContain(override);
    expect(paths).toContain(join(home, 'custom-claude', 'CLAUDE.md'));
    expect(paths).toContain(join(home, 'custom-grok', 'AGENTS.md'));
    const updated = readFileSync(override, 'utf8');
    expect(updated).toContain('My preferences.');
    expect(updated).not.toContain('Old Concord instructions');
    expect(updated.split(BLOCK_START)).toHaveLength(2);
    expect(readFileSync(join(codex, 'AGENTS.md'), 'utf8')).toBe('Inactive instructions.\n');
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('leaves an empty Codex override empty so existing AGENTS.md remains active', () => {
    const home = temporaryHome();
    const codex = join(home, '.codex');
    mkdirSync(codex);
    writeFileSync(join(codex, 'AGENTS.override.md'), '\n');
    writeFileSync(join(codex, 'AGENTS.md'), 'Existing preferences.\n');
    installGlobalInstructions({ HOME: home });
    expect(readFileSync(join(codex, 'AGENTS.override.md'), 'utf8')).toBe('\n');
    expect(readFileSync(join(codex, 'AGENTS.md'), 'utf8')).toContain('Existing preferences.');
  });
});
