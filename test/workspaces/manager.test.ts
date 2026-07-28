import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { workspaceIdForRoot } from '../../src/config/paths.js';
import { openRepositories } from '../../src/db/index.js';
import { WorkspaceManager, routedRepositories } from '../../src/workspaces/manager.js';

function repoDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `concord-${label}-`));
  mkdirSync(join(root, '.git'));
  return realpathSync(root);
}

describe('WorkspaceManager', () => {
  it('joins and switches between repositories in one process', () => {
    const first = repoDir('first');
    const second = repoDir('second');
    const manager = new WorkspaceManager(first);
    const routed = routedRepositories(manager);

    routed.tasks.create({
      taskId: 'FIRST',
      title: 'First',
      owner: null,
      agent: null,
      branch: null,
      worktree: null,
      expectedFiles: [],
      modules: [],
      domains: [],
      riskTags: [],
      notes: null,
      parentTaskId: null,
      agentId: null,
    });
    const joined = manager.join(second);
    expect(joined.firstOpen).toBe(true);
    expect(routed.tasks.list()).toEqual([]);

    manager.select(workspaceIdForRoot(first));
    expect(routed.tasks.list().map((task) => task.taskId)).toEqual(['FIRST']);
  });

  it('opens a workspace only once when it is selected repeatedly', () => {
    const first = repoDir('cached');
    const open = vi.fn(openRepositories);
    const manager = new WorkspaceManager(first, { open });

    expect(manager.join(first).firstOpen).toBe(false);
    manager.select(workspaceIdForRoot(first));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('rejects roots outside an explicit allowlist', () => {
    const allowed = repoDir('allowed');
    const denied = repoDir('denied');
    const manager = new WorkspaceManager(allowed, { allowedRoots: [allowed] });

    expect(() => manager.join(denied)).toThrow(/Workspace root is not allowed/u);
  });

  it('rejects malformed workspace ids', () => {
    const root = repoDir('invalid-id');
    const manager = new WorkspaceManager(root);
    expect(() => manager.select('not-a-workspace')).toThrow(/Invalid workspace id/u);
  });
});
