import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
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
  it('opens no further store once its machine is linked, keeping the ones it has', () => {
    const first = repoDir('first');
    const second = repoDir('second');
    let linked = false;
    const manager = new WorkspaceManager(first, {
      refuseOpen: () => (linked ? 'This machine works through Concord Cloud' : undefined),
    });

    linked = true;
    expect(() => manager.join(second)).toThrow(/works through Concord Cloud/u);
    expect(existsSync(join(second, '.concord'))).toBe(false);
    // A store it already holds stays usable: `archiveStore` sees it is open.
    expect(manager.join(first).repoRoot).toBe(first);
  });

  it('can start outside a repository and explicitly join one later', () => {
    const launchRoot = mkdtempSync(join(tmpdir(), 'concord-mcp-launch-root-'));
    const repoRoot = repoDir('joined-after-launch');
    const manager = new WorkspaceManager(launchRoot);

    const joined = manager.join(repoRoot);

    expect(joined.repoRoot).toBe(repoRoot);
    expect(joined.workspaceId).toBe(workspaceIdForRoot(repoRoot));
    expect(manager.current().repoRoot).toBe(repoRoot);
  });

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
