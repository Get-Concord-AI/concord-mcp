import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { concordDir, databasePath, findRepoRoot } from '../../src/config/paths.js';

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
