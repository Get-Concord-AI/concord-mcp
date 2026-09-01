import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDefaultOwner } from '../../src/config/default-owner.js';

function gitRepoWithLocalUserName(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'concord-owner-')));
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.name', name]);
  return root;
}

describe('resolveDefaultOwner', () => {
  it('prefers CONCORD_DEFAULT_OWNER over git config', () => {
    const root = gitRepoWithLocalUserName('From Git');
    expect(resolveDefaultOwner({ CONCORD_DEFAULT_OWNER: ' From Env ' }, root)).toBe('From Env');
  });

  it('falls back to the repository git user.name', () => {
    const root = gitRepoWithLocalUserName('Repo Local Owner');
    expect(resolveDefaultOwner({}, root)).toBe('Repo Local Owner');
  });

  it('returns null when neither source resolves', () => {
    expect(resolveDefaultOwner({}, join(tmpdir(), 'concord-owner-does-not-exist'))).toBeNull();
  });
});
