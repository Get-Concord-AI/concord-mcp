import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  concordDir,
  databasePath,
  findRepoRoot,
  resolveExplicitRepoRoot,
  resolveRepoRoot,
  workspaceIdForRoot,
  workspaceRootFromId,
} from '../../src/config/paths.js';

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
    expect(findRepoRoot(nested)).toBe(realpathSync(root));
  });

  it('falls back to the start dir when no .git is found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-nogit-'));
    expect(findRepoRoot(dir)).toBe(realpathSync(dir));
  });

  it('maps a linked worktree to the primary checkout root', () => {
    const primary = mkdtempSync(join(tmpdir(), 'concord-primary-'));
    const worktree = mkdtempSync(join(tmpdir(), 'concord-worktree-'));
    const worktreeGitDir = join(primary, '.git', 'worktrees', 'feature');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n');
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);
    const nested = join(worktree, 'packages', 'cli');
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(realpathSync(primary));
    expect(databasePath(findRepoRoot(nested))).toBe(databasePath(realpathSync(primary)));
  });

  it('validates explicit roots rather than silently creating them', () => {
    const parent = mkdtempSync(join(tmpdir(), 'concord-explicit-'));
    expect(() => resolveExplicitRepoRoot(join(parent, 'missing'))).toThrow(
      /Workspace root does not exist/u,
    );
  });

  it('round-trips a canonical root through a workspace id', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-workspace-id-'));
    mkdirSync(join(root, '.git'));
    const workspaceId = workspaceIdForRoot(root);

    expect(workspaceId).toMatch(/^ws_/u);
    expect(workspaceRootFromId(workspaceId)).toBe(realpathSync(root));
    expect(() => workspaceRootFromId('ws_not valid')).toThrow(/Invalid workspace id/u);
  });
});

describe('resolveRepoRoot', () => {
  it('uses process cwd when no env override is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-cwd-'));
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'pkg');
    mkdirSync(nested);
    expect(resolveRepoRoot(nested, {})).toBe(realpathSync(root));
  });

  it('prefers CLAUDE_PROJECT_DIR over cwd and normalizes to the git root', () => {
    const project = mkdtempSync(join(tmpdir(), 'concord-proj-'));
    mkdirSync(join(project, '.git'));
    const nested = join(project, 'src');
    mkdirSync(nested);
    const elsewhere = mkdtempSync(join(tmpdir(), 'concord-elsewhere-'));
    // cwd is an unrelated directory; the project dir must win.
    expect(resolveRepoRoot(elsewhere, { CLAUDE_PROJECT_DIR: nested })).toBe(realpathSync(project));
  });

  it('lets CONCORD_REPO_ROOT override CLAUDE_PROJECT_DIR', () => {
    const forced = mkdtempSync(join(tmpdir(), 'concord-forced-'));
    mkdirSync(join(forced, '.git'));
    const project = mkdtempSync(join(tmpdir(), 'concord-proj2-'));
    mkdirSync(join(project, '.git'));
    expect(
      resolveRepoRoot('/nowhere', { CONCORD_REPO_ROOT: forced, CLAUDE_PROJECT_DIR: project }),
    ).toBe(realpathSync(forced));
  });

  it('ignores blank env values', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-blank-'));
    mkdirSync(join(root, '.git'));
    expect(resolveRepoRoot(root, { CONCORD_REPO_ROOT: '  ', CLAUDE_PROJECT_DIR: '' })).toBe(
      realpathSync(root),
    );
  });

  it('rejects an invalid explicit environment root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'concord-invalid-env-'));
    expect(() => resolveRepoRoot(parent, { CONCORD_REPO_ROOT: join(parent, 'missing') })).toThrow(
      /Workspace root does not exist/u,
    );
  });
});
