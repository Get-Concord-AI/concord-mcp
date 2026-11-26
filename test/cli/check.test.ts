import { beforeEach, describe, expect, it } from 'vitest';

import { checkFileOverlaps, renderCheck } from '../../src/cli/commands/check.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { ROOT_CLAIMS } from '../helpers/root-claims.js';

describe('concord check', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('reports no overlap when the files are unclaimed', () => {
    handleClaimWork(repos, { task_id: 'T1', title: 'Other', expected_files: ['src/a.ts'] });
    const overlaps = checkFileOverlaps(repos, ['src/b.ts']);
    expect(overlaps).toEqual([]);
    expect(renderCheck(['src/b.ts'], overlaps)).toContain('OK');
  });

  it('flags a file already claimed by another active task (with path normalization)', () => {
    handleClaimWork(repos, {
      task_id: 'T1',
      title: 'Owns retry',
      expected_files: ['src/billing/retry.ts'],
    });
    // Leading ./ is normalized (see #30), so this still collides.
    const overlaps = checkFileOverlaps(repos, ['./src/billing/retry.ts']);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.taskId).toBe('T1');
    expect(renderCheck(['src/billing/retry.ts'], overlaps)).toContain('Overlap');

    // Windows backslash paths are normalized so they collide with POSIX claims.
    const winOverlaps = checkFileOverlaps(repos, ['.\\src\\billing\\retry.ts']);
    expect(winOverlaps).toHaveLength(1);
    expect(winOverlaps[0]?.taskId).toBe('T1');
  });

  it.each(['win32', 'darwin'] as const)(
    'flags a claimed file named with different case on %s',
    (platform) => {
      handleClaimWork(repos, {
        task_id: 'T1',
        title: 'Owns button',
        expected_files: ['src/components/Button.tsx'],
      });
      const overlaps = checkFileOverlaps(repos, ['src/Components/Button.tsx'], undefined, {
        platform,
      });
      expect(overlaps.map((overlap) => overlap.taskId)).toEqual(['T1']);
    },
  );

  it('keeps the edit guard case-sensitive on linux', () => {
    handleClaimWork(repos, {
      task_id: 'T1',
      title: 'Owns button',
      expected_files: ['src/components/Button.tsx'],
    });
    expect(
      checkFileOverlaps(repos, ['src/Components/Button.tsx'], undefined, { platform: 'linux' }),
    ).toEqual([]);
  });

  it('excludes your own task via --task', () => {
    handleClaimWork(repos, { task_id: 'MINE', title: 'Mine', expected_files: ['src/x.ts'] });
    expect(checkFileOverlaps(repos, ['src/x.ts'], 'MINE')).toEqual([]);
    // Without excluding self, the file matches its own claim.
    expect(checkFileOverlaps(repos, ['src/x.ts'])).toHaveLength(1);
  });

  it('ignores non-active tasks', () => {
    handleClaimWork(repos, { task_id: 'DONE', title: 'Done', expected_files: ['src/x.ts'] });
    repos.tasks.updateStatus('DONE', 'review_ready');
    expect(checkFileOverlaps(repos, ['src/x.ts'])).toEqual([]);
  });

  it('flags a file inside a directory claimed by another task', () => {
    handleClaimWork(repos, { task_id: 'T1', title: 'Owns app', expected_files: ['src/app/'] });
    const overlaps = checkFileOverlaps(repos, ['./src/app/page.tsx']);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.taskId).toBe('T1');
    expect(overlaps[0]?.reasons).toEqual(['inside claimed directory: src/app/page.tsx']);
    // Same-prefix sibling directory is not inside the claim.
    expect(checkFileOverlaps(repos, ['src/application/page.tsx'])).toEqual([]);
  });

  it.each(ROOT_CLAIMS)('flags files covered by root claim %j', (root) => {
    handleClaimWork(repos, { task_id: 'T1', title: 'Owns repo', expected_files: [root] });

    expect(checkFileOverlaps(repos, ['src/app/page.tsx', 'README.md'])).toEqual([
      {
        taskId: 'T1',
        title: 'Owns repo',
        reasons: ['inside claimed directory: README.md, src/app/page.tsx'],
        kinds: ['same_file'],
      },
    ]);
  });

  it.each(['', ' \t '])('ignores blank claim %j', (blank) => {
    handleClaimWork(repos, { task_id: 'T1', title: 'Has blank entry', expected_files: [blank] });

    expect(checkFileOverlaps(repos, ['src/app/page.tsx'])).toEqual([]);
  });

  it('flags a file inside a directory claimed with different case on win32, not linux', () => {
    handleClaimWork(repos, { task_id: 'T1', title: 'Owns app', expected_files: ['Src/App'] });

    expect(checkFileOverlaps(repos, ['src/app/x.ts'], undefined, { platform: 'win32' })).toEqual([
      {
        taskId: 'T1',
        title: 'Owns app',
        reasons: ['inside claimed directory: src/app/x.ts'],
        kinds: ['same_file'],
      },
    ]);
    expect(checkFileOverlaps(repos, ['src/app/x.ts'], undefined, { platform: 'linux' })).toEqual(
      [],
    );
    expect(checkFileOverlaps(repos, ['src/app/x.ts'])).toEqual([]);
  });

  it('reports a case-insensitive same-file match once, as the claim spells it', () => {
    handleClaimWork(repos, {
      task_id: 'T1',
      title: 'Owns button',
      expected_files: ['src/Btn.tsx'],
    });

    expect(
      checkFileOverlaps(repos, ['src/btn.tsx', 'SRC/BTN.tsx'], undefined, { platform: 'darwin' }),
    ).toEqual([
      {
        taskId: 'T1',
        title: 'Owns button',
        reasons: ['same file(s): src/Btn.tsx'],
        kinds: ['same_file'],
      },
    ]);
  });

  it('flags mixed-case files under a root claim on win32', () => {
    handleClaimWork(repos, { task_id: 'T1', title: 'Owns repo', expected_files: ['.'] });

    expect(checkFileOverlaps(repos, ['Src/App/x.ts'], undefined, { platform: 'win32' })).toEqual([
      {
        taskId: 'T1',
        title: 'Owns repo',
        reasons: ['inside claimed directory: Src/App/x.ts'],
        kinds: ['same_file'],
      },
    ]);
  });

  it('renders a usage hint when no files are given', () => {
    expect(renderCheck([], [])).toContain('Usage: concord check');
  });
});
