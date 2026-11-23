import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TaskRecord } from '../../src/db/index.js';
import { detectOverlaps, normalizePath, type OverlapSurface } from '../../src/domain/overlap.js';

function task(partial: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    taskId: partial.taskId,
    title: partial.title ?? partial.taskId,
    owner: null,
    agent: null,
    branch: null,
    worktree: null,
    expectedFiles: partial.expectedFiles ?? [],
    modules: partial.modules ?? [],
    domains: partial.domains ?? [],
    riskTags: partial.riskTags ?? [],
    notes: null,
    status: partial.status ?? 'active',
    parentTaskId: partial.parentTaskId ?? null,
    agentId: null,
    version: partial.version ?? 1,
    assignedAgentId: partial.assignedAgentId ?? null,
    leaseExpiresAt: partial.leaseExpiresAt ?? null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

const candidate: OverlapSurface = {
  taskId: 'TASK-A',
  expectedFiles: ['src/billing/retry.ts'],
  modules: ['billing', 'stripe'],
  domains: ['payments'],
  riskTags: ['payment-flow'],
};

describe('detectOverlaps', () => {
  it('flags a shared module and directory (the plan demo case)', () => {
    const warnings = detectOverlaps(candidate, [
      task({
        taskId: 'TASK-B',
        title: 'Invoices',
        expectedFiles: ['src/billing/invoices.ts'],
        modules: ['billing'],
      }),
    ]);
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning?.taskId).toBe('TASK-B');
    expect(warning?.reasons).toContain('shared module(s): billing');
    expect(warning?.reasons).toContain('same directory: src/billing');
  });

  it('flags an exact same-file overlap and omits the directory reason', () => {
    const warnings = detectOverlaps(candidate, [
      task({ taskId: 'TASK-C', expectedFiles: ['src/billing/retry.ts'] }),
    ]);
    expect(warnings[0]?.reasons).toContain('same file(s): src/billing/retry.ts');
    expect(warnings[0]?.reasons.some((r) => r.startsWith('same directory'))).toBe(false);
  });

  it('flags shared domains and risk tags (reported as normalized tokens)', () => {
    const warnings = detectOverlaps(candidate, [
      task({ taskId: 'TASK-D', domains: ['payments'], riskTags: ['payment-flow'] }),
    ]);
    expect(warnings[0]?.reasons).toContain('shared domain(s): payments');
    // 'payment-flow' tokenizes to {payment, flow}; reasons name the shared tokens.
    expect(warnings[0]?.reasons).toContain('shared risk tag(s): flow, payment');
  });

  it('matches labels across case, whitespace, and word order (the dogfooding miss)', () => {
    // A UX task declared domains as the single phrase "todo frontend"; the
    // implementation task declared ["frontend", "todo"]. Exact matching missed
    // this; token matching catches it.
    const uxCandidate: OverlapSurface = {
      taskId: 'TASK-UX',
      expectedFiles: [],
      modules: ['frontend UX'],
      domains: ['todo frontend'],
      riskTags: [],
    };
    const warnings = detectOverlaps(uxCandidate, [
      task({ taskId: 'TASK-FE', title: 'Frontend', domains: ['Frontend', 'todo'] }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reasons).toContain('shared domain(s): frontend, todo');
  });

  it.each(['支付', 'платежи', '認証', 'café', 'भुगतान'])(
    'flags a shared module, domain, and risk tag written as %s',
    (label) => {
      const surface: OverlapSurface = {
        taskId: 'TASK-U',
        expectedFiles: [],
        modules: [label],
        domains: [label],
        riskTags: [label],
      };
      const warnings = detectOverlaps(surface, [
        task({ taskId: 'TASK-V', modules: [label], domains: [label], riskTags: [label] }),
      ]);
      expect(warnings[0]?.kinds).toEqual(['shared_module', 'shared_domain', 'shared_risk_tag']);
    },
  );

  it('matches non-Latin labels across case and separators', () => {
    const surface: OverlapSurface = {
      taskId: 'TASK-U',
      expectedFiles: [],
      modules: ['Платежи-Сервис'],
      domains: [],
      riskTags: [],
    };
    const warnings = detectOverlaps(surface, [
      task({ taskId: 'TASK-V', modules: ['сервис платежи'] }),
    ]);
    expect(warnings[0]?.reasons).toContain('shared module(s): платежи, сервис');
  });

  it('does not flag different non-Latin labels', () => {
    const surface: OverlapSurface = {
      taskId: 'TASK-U',
      expectedFiles: [],
      modules: ['支付'],
      domains: [],
      riskTags: [],
    };
    expect(detectOverlaps(surface, [task({ taskId: 'TASK-V', modules: ['认证'] })])).toEqual([]);
  });

  // Escapes keep the source bytes stable: an editor could silently normalize the literals.
  it.each([
    ['composed and decomposed', 'café', 'café'],
    ['full-width and ASCII', 'ＡＢ', 'ab'],
  ])('matches %s spellings of the same label', (_name, left, right) => {
    const surface: OverlapSurface = {
      taskId: 'TASK-U',
      expectedFiles: [],
      modules: [left],
      domains: [],
      riskTags: [],
    };
    const warnings = detectOverlaps(surface, [task({ taskId: 'TASK-V', modules: [right] })]);
    expect(warnings[0]?.kinds).toEqual(['shared_module']);
  });

  it('keeps an accented label distinct from its unaccented spelling', () => {
    const surface: OverlapSurface = {
      taskId: 'TASK-U',
      expectedFiles: [],
      modules: ['café'],
      domains: [],
      riskTags: [],
    };
    expect(detectOverlaps(surface, [task({ taskId: 'TASK-V', modules: ['cafe'] })])).toEqual([]);
  });

  it('treats kebab, snake, and space separators as equivalent for modules', () => {
    const kebab: OverlapSurface = {
      taskId: 'TASK-K',
      expectedFiles: [],
      modules: ['app-shell'],
      domains: [],
      riskTags: [],
    };
    const warnings = detectOverlaps(kebab, [task({ taskId: 'TASK-S', modules: ['app_shell'] })]);
    expect(warnings[0]?.reasons).toContain('shared module(s): app, shell');
  });

  it('normalizes file paths so ./app/page.tsx and app/page.tsx are the same file', () => {
    const withDotSlash: OverlapSurface = {
      taskId: 'TASK-P',
      expectedFiles: ['./app/page.tsx'],
      modules: [],
      domains: [],
      riskTags: [],
    };
    const sameFile = detectOverlaps(withDotSlash, [
      task({ taskId: 'TASK-Q', expectedFiles: ['app/page.tsx'] }),
    ]);
    expect(sameFile[0]?.reasons).toContain('same file(s): app/page.tsx');

    const sameDir = detectOverlaps(withDotSlash, [
      task({ taskId: 'TASK-R', expectedFiles: ['app//layout.tsx'] }),
    ]);
    expect(sameDir[0]?.reasons).toContain('same directory: app');
  });

  it('normalizes Windows backslash paths so Windows and POSIX paths collide as the same file and directory', () => {
    const windowsTask: OverlapSurface = {
      taskId: 'TASK-WIN',
      expectedFiles: ['.\\src\\billing\\retry.ts', 'src\\billing\\invoices.ts'],
      modules: [],
      domains: [],
      riskTags: [],
    };
    const sameFile = detectOverlaps(windowsTask, [
      task({ taskId: 'TASK-POSIX', expectedFiles: ['src/billing/retry.ts'] }),
    ]);
    expect(sameFile[0]?.reasons).toContain('same file(s): src/billing/retry.ts');

    const sameDir = detectOverlaps(
      {
        taskId: 'TASK-WIN-DIR',
        expectedFiles: ['src\\billing\\other.ts'],
        modules: [],
        domains: [],
        riskTags: [],
      },
      [task({ taskId: 'TASK-POSIX-DIR', expectedFiles: ['src/billing/retry.ts'] })],
    );
    expect(sameDir[0]?.reasons).toContain('same directory: src/billing');
  });

  it('returns nothing for disjoint tasks', () => {
    expect(
      detectOverlaps(candidate, [
        task({ taskId: 'TASK-E', expectedFiles: ['src/signup/page.tsx'], modules: ['signup'] }),
      ]),
    ).toEqual([]);
  });

  it('never flags a task against itself', () => {
    expect(detectOverlaps(candidate, [task({ taskId: 'TASK-A', modules: ['billing'] })])).toEqual(
      [],
    );
  });

  it('does not flag a task against its own parent or child (but still flags others)', () => {
    const child: OverlapSurface = {
      taskId: 'FE-1.1',
      parentTaskId: 'FE-1',
      expectedFiles: [],
      modules: ['app-shell'],
      domains: [],
      riskTags: [],
    };
    // Shares a module with its parent — expected, so not flagged.
    expect(detectOverlaps(child, [task({ taskId: 'FE-1', modules: ['app-shell'] })])).toEqual([]);
    // The reverse direction (parent candidate vs child) is also excluded.
    const parent: OverlapSurface = {
      taskId: 'FE-1',
      expectedFiles: [],
      modules: ['app-shell'],
      domains: [],
      riskTags: [],
    };
    expect(
      detectOverlaps(parent, [
        task({ taskId: 'FE-1.1', modules: ['app-shell'], parentTaskId: 'FE-1' }),
      ]),
    ).toEqual([]);
    // An unrelated task sharing the module is still flagged.
    expect(detectOverlaps(child, [task({ taskId: 'OTHER', modules: ['app-shell'] })])).toHaveLength(
      1,
    );
  });

  it('skips an existing-task prefix when an offset is provided', () => {
    const existing = [
      task({ taskId: 'TASK-B', modules: ['billing'] }),
      task({ taskId: 'TASK-C', domains: ['payments'] }),
      task({ taskId: 'TASK-E', modules: ['signup'] }),
    ];

    const warnings = detectOverlaps(candidate, existing, 1);

    expect(warnings.map((warning) => warning.taskId)).toEqual(['TASK-C']);
    expect(warnings[0]?.reasons).toContain('shared domain(s): payments');
  });

  it('flags a directory claim that contains another task file, in both directions', () => {
    const dir: OverlapSurface = {
      taskId: 'DIR',
      expectedFiles: ['src/app/'],
      modules: [],
      domains: [],
      riskTags: [],
    };
    const file = task({ taskId: 'FILE', expectedFiles: ['src/app/page.tsx'] });
    const forward = detectOverlaps(dir, [file]);
    expect(forward[0]?.kinds).toContain('same_file');
    expect(forward[0]?.reasons).toContain(
      'directory claim covers file(s): src/app -> src/app/page.tsx',
    );

    const reverse = detectOverlaps({ ...dir, expectedFiles: ['src/app/page.tsx'] }, [
      task({ taskId: 'D2', expectedFiles: ['src/app'] }),
    ]);
    expect(reverse.map((warning) => warning.taskId)).toEqual(['D2']);
  });

  it.each(['.', './', '/'])('flags root claim %j in both directions', (root) => {
    const rootClaim = task({ taskId: 'ROOT', expectedFiles: [root] });
    const fileClaim = task({ taskId: 'FILE', expectedFiles: ['src/app/page.tsx'] });
    const reasons = ['directory claim covers file(s): . -> src/app/page.tsx'];

    expect(detectOverlaps(rootClaim, [fileClaim])).toEqual([
      { taskId: 'FILE', title: 'FILE', reasons, kinds: ['same_file'] },
    ]);
    expect(detectOverlaps(fileClaim, [rootClaim])).toEqual([
      { taskId: 'ROOT', title: 'ROOT', reasons, kinds: ['same_file'] },
    ]);
  });

  it('scopes root claims to the repository in both directions', () => {
    const repoRoot = resolve('workspace');
    const rootClaim = task({ taskId: 'ROOT', expectedFiles: ['.'] });
    const inside = join(`${repoRoot}-alias`, 'src', 'app.ts');
    const sibling = join(`${repoRoot}-other`, 'notes.md');
    const fileClaim = task({ taskId: 'FILE', expectedFiles: [inside] });
    const reasons = [`directory claim covers file(s): . -> ${normalizePath(inside)}`];
    const pathsFromCheckout = new Map([
      [normalizePath(inside), 'src/app.ts'],
      [normalizePath(sibling), '../workspace-other/notes.md'],
      [normalizePath(repoRoot), ''],
    ]);

    expect(detectOverlaps(rootClaim, [fileClaim], 0, pathsFromCheckout)).toEqual([
      { taskId: 'FILE', title: 'FILE', reasons, kinds: ['same_file'] },
    ]);
    expect(detectOverlaps(fileClaim, [rootClaim], 0, pathsFromCheckout)).toEqual([
      { taskId: 'ROOT', title: 'ROOT', reasons, kinds: ['same_file'] },
    ]);
    expect(detectOverlaps(rootClaim, [fileClaim])).toEqual([]);

    for (const outside of [
      '..',
      '../other-project/file.ts',
      sibling,
      repoRoot,
      'X:/other-project/notes.md',
    ]) {
      const otherClaim = task({ taskId: 'OTHER', expectedFiles: [outside] });
      expect(detectOverlaps(rootClaim, [otherClaim], 0, pathsFromCheckout)).toEqual([]);
      expect(detectOverlaps(otherClaim, [rootClaim], 0, pathsFromCheckout)).toEqual([]);
    }
  });

  it.skipIf(process.platform === 'win32')('covers POSIX relative filenames with a colon', () => {
    const rootClaim = task({ taskId: 'ROOT', expectedFiles: ['.'] });
    const fileClaim = task({ taskId: 'FILE', expectedFiles: ['a:notes.md'] });
    const reasons = ['directory claim covers file(s): . -> a:notes.md'];

    expect(detectOverlaps(rootClaim, [fileClaim])).toEqual([
      { taskId: 'FILE', title: 'FILE', reasons, kinds: ['same_file'] },
    ]);
    expect(detectOverlaps(fileClaim, [rootClaim])).toEqual([
      { taskId: 'ROOT', title: 'ROOT', reasons, kinds: ['same_file'] },
    ]);
  });

  it.each(['', ' \t '])('ignores blank claim %j', (blank) => {
    const blankClaim = task({ taskId: 'BLANK', expectedFiles: [blank] });
    const fileClaim = task({ taskId: 'FILE', expectedFiles: ['src/app/page.tsx'] });

    expect(detectOverlaps(blankClaim, [fileClaim])).toEqual([]);
    expect(detectOverlaps(fileClaim, [blankClaim])).toEqual([]);
  });

  it('reports the same_file kind once for exact and nested overlaps', () => {
    const left = task({ taskId: 'LEFT', expectedFiles: ['src/app', 'src/x.ts'] });
    const right = task({ taskId: 'RIGHT', expectedFiles: ['src/x.ts', 'src/app/page.tsx'] });

    expect(detectOverlaps(left, [right])).toEqual([
      {
        taskId: 'RIGHT',
        title: 'RIGHT',
        reasons: [
          'same file(s): src/x.ts',
          'directory claim covers file(s): src/app -> src/app/page.tsx',
        ],
        kinds: ['same_file'],
      },
    ]);
  });

  it('does not treat a sibling with a shared name prefix as inside the directory', () => {
    const dir: OverlapSurface = {
      taskId: 'DIR',
      expectedFiles: ['src/app'],
      modules: [],
      domains: [],
      riskTags: [],
    };
    const warnings = detectOverlaps(dir, [
      task({ taskId: 'OTHER', expectedFiles: ['src/application/page.tsx'] }),
    ]);
    expect(warnings.some((w) => w.reasons.some((r) => r.startsWith('directory claim')))).toBe(
      false,
    );
  });
});
