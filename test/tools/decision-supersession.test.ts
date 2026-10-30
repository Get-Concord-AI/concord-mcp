import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleGetTaskContext } from '../../src/tools/get-task-context.js';
import { handleInspectWork } from '../../src/tools/inspect-work.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';

describe('superseded decisions', () => {
  let repos: Repositories;
  let inline: number;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry payments', agent: 'claude-code' });
    inline = handleUpdateTask(repos, {
      task_id: 'TASK-12',
      kind: 'decision',
      content: 'Retry inline',
    }).update.id;
  });

  it('hides a replaced decision by default and keeps it when asked', () => {
    const queued = handleUpdateTask(repos, {
      task_id: 'TASK-12',
      kind: 'decision',
      content: 'Use a queued retry',
      supersedes: inline,
      supersede_reason: 'Inline retry blocks checkout',
    }).update.id;

    const visible = handleGetTaskContext(repos, { task_id: 'TASK-12' });
    expect(visible.updates.map((update) => update.id)).toEqual([queued]);

    const all = handleGetTaskContext(repos, { task_id: 'TASK-12', include_superseded: true });
    const replaced = all.updates.find((update) => update.id === inline);
    expect(replaced?.supersededBy).toBe(queued);
    expect(replaced?.supersedeReason).toBe('Inline retry blocks checkout');
    expect(replaced?.supersededAt).not.toBeNull();
  });

  it('passes include_superseded through inspect_work', () => {
    handleUpdateTask(repos, {
      task_id: 'TASK-12',
      kind: 'decision',
      content: 'Use a queued retry',
      supersedes: inline,
    });

    const hidden = handleInspectWork(repos, { task_id: 'TASK-12' });
    const shown = handleInspectWork(repos, { task_id: 'TASK-12', include_superseded: true });
    if (hidden.scope !== 'task' || shown.scope !== 'task') {
      throw new Error('expected task-scoped inspect results');
    }
    expect(hidden.context.updates).toHaveLength(1);
    expect(shown.context.updates).toHaveLength(2);
  });

  it('rejects supersedes on a non-decision update', () => {
    expect(() =>
      handleUpdateTask(repos, {
        task_id: 'TASK-12',
        kind: 'intent',
        content: 'Keep checkout fast',
        supersedes: inline,
      }),
    ).toThrow('supersedes applies only to decision updates');
  });

  it('rejects a missing decision, one on another task, or one already replaced', () => {
    expect(() =>
      handleUpdateTask(repos, {
        task_id: 'TASK-12',
        kind: 'decision',
        content: 'Replace nothing',
        supersedes: 9999,
      }),
    ).toThrow('is not recorded on TASK-12');

    handleClaimWork(repos, { task_id: 'TASK-14', title: 'Invoice totals', agent: 'claude-code' });
    const elsewhere = handleUpdateTask(repos, {
      task_id: 'TASK-14',
      kind: 'decision',
      content: 'Round per line',
    }).update.id;
    expect(() =>
      handleUpdateTask(repos, {
        task_id: 'TASK-12',
        kind: 'decision',
        content: 'Replace other task',
        supersedes: elsewhere,
      }),
    ).toThrow('is not recorded on TASK-12');

    handleUpdateTask(repos, {
      task_id: 'TASK-12',
      kind: 'decision',
      content: 'Queued retry',
      supersedes: inline,
    });
    expect(() =>
      handleUpdateTask(repos, {
        task_id: 'TASK-12',
        kind: 'decision',
        content: 'Third option',
        supersedes: inline,
      }),
    ).toThrow('is already superseded');
  });

  it('rejects a reason without a decision to replace', () => {
    expect(() =>
      handleUpdateTask(repos, {
        task_id: 'TASK-12',
        kind: 'decision',
        content: 'Orphan reason',
        supersede_reason: 'No target',
      }),
    ).toThrow('supersede_reason requires supersedes');
  });
});
