import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { buildStatus, renderStatusText } from '../../src/cli/commands/status.js';
import { renderTasks } from '../../src/cli/commands/tasks.js';
import { runInit } from '../../src/cli/commands/init.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleReviewReady } from '../../src/tools/review-ready.js';

function repoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'concord-cli-'));
  mkdirSync(join(dir, '.git'));
  return dir;
}

describe('runInit', () => {
  it('creates the .concord workspace with a database', () => {
    const dir = repoDir();
    const concordPath = runInit(dir);
    expect(concordPath).toBe(join(dir, '.concord'));
    expect(existsSync(join(concordPath, 'concord.db'))).toBe(true);
    expect(existsSync(join(concordPath, 'WORK_STATE.json'))).toBe(true);
  });
});

describe('renderTasks', () => {
  it('shows a placeholder when there are no tasks', () => {
    expect(renderTasks([])).toContain('No tasks yet');
  });

  it('renders a row per task', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry', agent: 'claude-code' });
    const output = renderTasks(repos.tasks.list());
    expect(output).toContain('TASK-12');
    expect(output).toContain('claude-code');
    expect(output).toContain('Retry');
  });
});

describe('buildStatus / renderStatusText', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('reports none across all sections when empty', () => {
    const text = renderStatusText(buildStatus(repos));
    expect(text).toContain('Active work\n  none');
    expect(text).toContain('Potential overlaps\n  none');
  });

  it('lists active work and overlaps between active tasks', () => {
    handleClaimWork(repos, {
      task_id: 'TASK-12',
      title: 'Retry',
      agent: 'claude-code',
      branch: 'feat/retry',
      modules: ['billing'],
    });
    handleClaimWork(repos, {
      task_id: 'TASK-14',
      title: 'Invoices',
      agent: 'codex',
      modules: ['billing'],
    });

    const view = buildStatus(repos);
    expect(view.active).toHaveLength(2);
    expect(view.overlaps).toHaveLength(1);

    const text = renderStatusText(view);
    expect(text).toContain('TASK-12');
    expect(text).toContain('touches: billing');
    expect(text).toContain('TASK-12 <-> TASK-14');
  });

  it('surfaces a later overlap to the earlier claimant on read (closes the point-in-time gap)', () => {
    // The first claim sees no overlaps — nobody else was active yet (#29).
    const first = handleClaimWork(repos, {
      task_id: 'TASK-1',
      title: 'Frontend',
      domains: ['todo'],
    });
    expect(first.overlaps).toEqual([]);
    expect(first.checkedAgainst).toBe(0);

    // A second, overlapping claim lands after. The earlier claimant was never
    // told at claim time — but status recomputes overlaps live, so the pair is
    // now visible to both sides.
    handleClaimWork(repos, { task_id: 'TASK-2', title: 'Backend', domains: ['todo'] });

    const view = buildStatus(repos);
    expect(view.overlaps).toHaveLength(1);
    expect(renderStatusText(view)).toContain('TASK-1 <-> TASK-2');
  });

  it('lists review-ready tasks and their open questions', () => {
    handleClaimWork(repos, { task_id: 'TASK-9', title: 'Retry', modules: ['billing'] });
    handleReviewReady(repos, {
      task_id: 'TASK-9',
      plan_summary: 'x',
      tests_run: ['pnpm test'],
      open_questions: ['Sync or queued retries?'],
    });

    const view = buildStatus(repos);
    expect(view.reviewReady[0]?.openQuestionCount).toBe(1);
    expect(view.active).toHaveLength(0);
    expect(renderStatusText(view)).toContain('Sync or queued retries?');
  });
});
