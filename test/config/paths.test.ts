import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { concordDir, databasePath, findRepoRoot, resolveRepoRoot } from '../../src/config/paths.js';

describe('paths', () => {
  it('derives .concord and db paths from a repo root', () => {
    expect(concordDir('/repo')).toBe(join('/repo', '.concord'));
    expect(databasePath('/repo')).toBe(join('/repo', '.concord', 'concord.db'));
  });

  it('finds the repo root by walking up to a .git directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-'));
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(root);
  });

  it('falls back to the start dir when no .git is found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-nogit-'));
    expect(findRepoRoot(dir)).toBe(dir);
  });
});

describe('resolveRepoRoot', () => {
  it('uses process cwd when no env override is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-cwd-'));
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'pkg');
    mkdirSync(nested);
    expect(resolveRepoRoot(nested, {})).toBe(root);
  });

  it('prefers CLAUDE_PROJECT_DIR over cwd and normalizes to the git root', () => {
    const project = mkdtempSync(join(tmpdir(), 'concord-proj-'));
    mkdirSync(join(project, '.git'));
    const nested = join(project, 'src');
    mkdirSync(nested);
    const elsewhere = mkdtempSync(join(tmpdir(), 'concord-elsewhere-'));
    // cwd is an unrelated directory; the project dir must win.
    expect(resolveRepoRoot(elsewhere, { CLAUDE_PROJECT_DIR: nested })).toBe(project);
  });

  it('lets CONCORD_REPO_ROOT override CLAUDE_PROJECT_DIR', () => {
    const forced = mkdtempSync(join(tmpdir(), 'concord-forced-'));
    mkdirSync(join(forced, '.git'));
    const project = mkdtempSync(join(tmpdir(), 'concord-proj2-'));
    mkdirSync(join(project, '.git'));
    expect(
      resolveRepoRoot('/nowhere', { CONCORD_REPO_ROOT: forced, CLAUDE_PROJECT_DIR: project }),
    ).toBe(forced);
  });

  it('ignores blank env values', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-blank-'));
    mkdirSync(join(root, '.git'));
    expect(resolveRepoRoot(root, { CONCORD_REPO_ROOT: '  ', CLAUDE_PROJECT_DIR: '' })).toBe(root);
  });
});
