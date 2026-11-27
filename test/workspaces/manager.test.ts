import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { workspaceIdForRoot } from '../../src/config/paths.js';
import { openRepositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleGetTaskContext } from '../../src/tools/get-task-context.js';
import { handleGetWorkState } from '../../src/tools/get-work-state.js';
import { WorkspaceManager, routedRepositories } from '../../src/workspaces/manager.js';

function repoDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `concord-${label}-`));
  mkdirSync(join(root, '.git'));
  return realpathSync(root);
}

describe('WorkspaceManager', () => {
  it('stops using a store it already opened once its machine is linked', () => {
    const first = repoDir('first');
    const second = repoDir('second');
    let now = 0;
    let linked = false;
    const manager = new WorkspaceManager(first, {
      now: () => now,
      refuseOpen: () => (linked ? 'This machine works through Concord Cloud' : undefined),
    });
    const routed = routedRepositories(manager);
    const firstId = workspaceIdForRoot(first);

    linked = true;
    now = 1_000;
    expect(() => manager.join(second)).toThrow(/works through Concord Cloud/u);
    expect(existsSync(join(second, '.concord'))).toBe(false);
    expect(() => manager.join(first)).toThrow(/works through Concord Cloud/u);
    expect(() => manager.current()).toThrow(/works through Concord Cloud/u);
    expect(() => manager.select(firstId)).toThrow(/works through Concord Cloud/u);
    expect(() => routed.tasks.list()).toThrow(/works through Concord Cloud/u);
  });

  it('reuses a link check for a second, then reads it again', () => {
    const root = repoDir('cached-link');
    let now = 0;
    let linked = false;
    let reads = 0;
    const manager = new WorkspaceManager(root, {
      now: () => now,
      refuseOpen: () => {
        reads += 1;
        return linked ? 'This machine works through Concord Cloud' : undefined;
      },
    });
    const opened = reads;

    manager.current();
    now = 999;
    manager.current();
    expect(reads).toBe(opened);

    now = 1_000;
    expect(manager.current().repoRoot).toBe(root);
    expect(reads).toBe(opened + 1);

    linked = true;
    now = 1_999;
    expect(manager.current().repoRoot).toBe(root);
    expect(reads).toBe(opened + 1);

    now = 2_000;
    expect(() => manager.current()).toThrow(/works through Concord Cloud/u);
    expect(reads).toBe(opened + 2);
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

  it('scopes root claim overlaps to the currently selected workspace', () => {
    const first = repoDir('claim-first');
    const second = repoDir('claim-second');
    const manager = new WorkspaceManager(first);
    const routed = routedRepositories(manager);
    manager.join(second);
    handleClaimWork(routed, { task_id: 'ROOT', title: 'Claims root', expected_files: ['/'] });

    const outside = handleClaimWork(routed, {
      task_id: 'OUTSIDE',
      title: 'Outside workspace',
      expected_files: [join(first, 'src', 'app.ts')],
    });
    expect(outside.overlaps).toEqual([]);

    const inside = handleClaimWork(routed, {
      task_id: 'INSIDE',
      title: 'Inside workspace',
      expected_files: [join(second, 'src', 'app.ts')],
    });
    expect(inside.overlaps.map((warning) => warning.taskId)).toEqual(['ROOT']);
    expect(handleGetTaskContext(routed, { task_id: 'INSIDE' }).overlaps).toEqual(inside.overlaps);

    const { overlaps } = handleGetWorkState(routed);
    expect(overlaps).toHaveLength(1);
    expect([overlaps[0]?.a, overlaps[0]?.b].sort()).toEqual(['INSIDE', 'ROOT']);
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
