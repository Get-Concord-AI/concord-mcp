import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pathFromCheckout } from '../../src/workspaces/overlap-paths.js';

const dirs: string[] = [];

function checkout(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'concord-from-checkout-')));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'));
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('pathFromCheckout', () => {
  it('names an absolute path inside the checkout relative to it', () => {
    const root = checkout();
    expect(pathFromCheckout(root, join(root, 'src', 'app.ts'))).toBe('src/app.ts');
    expect(pathFromCheckout(root, 'src/app.ts')).toBe('src/app.ts');
  });

  it('names a path through a symlinked repo path like the real one, even for a new file', () => {
    const root = checkout();
    const logical = join(checkout(), 'repo');
    symlinkSync(root, logical, 'junction');
    expect(pathFromCheckout(root, join(logical, 'src', 'brandnew.ts'))).toBe('src/brandnew.ts');
  });

  it('leaves root claims, paths outside the checkout and unknown checkouts as given', () => {
    const root = checkout();
    const outside = join(`${root}-other`, 'notes.md');
    expect(pathFromCheckout(root, '.')).toBe('.');
    expect(pathFromCheckout(root, outside)).toBe(outside);
    expect(pathFromCheckout(root, '../notes.md')).toBe('../notes.md');
    expect(pathFromCheckout(undefined, '/abs/src/app.ts')).toBe('/abs/src/app.ts');
  });
});
