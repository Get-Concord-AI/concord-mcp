import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from '@commander-js/extra-typings';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { buildStatus, renderStatusText } from '../../src/artifacts/work-state-view.js';
import { registerSetupCommand, runSetup } from '../../src/cli/commands/setup.js';
import { renderTasks } from '../../src/cli/commands/tasks.js';
import { runWho } from '../../src/cli/commands/who.js';
import { openContext } from '../../src/cli/context.js';
import { configureCliWorkspace } from '../../src/cli/workspace-options.js';
import { workspaceIdForRoot } from '../../src/config/paths.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import { handleReviewReady } from '../../src/tools/review-ready.js';

function repoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'concord-cli-'));
  mkdirSync(join(dir, '.git'));
  return realpathSync(dir);
}

describe('runSetup', () => {
  it('registers one setup command without separate init/install commands', () => {
    const program = new Command();
    registerSetupCommand(program);

    expect(program.commands.map((command) => command.name())).toEqual(['setup']);
  });

  it('creates state, instructions, and repository-pinned MCP configs', () => {
    const dir = repoDir();
    const codexHome = mkdtempSync(join(tmpdir(), 'concord-codex-'));
    const result = runSetup(dir, { env: { CODEX_HOME: codexHome } });

    expect(result.concordPath).toBe(join(dir, '.concord'));
    expect(existsSync(join(result.concordPath, 'concord.db'))).toBe(true);
    expect(existsSync(join(result.concordPath, 'WORK_STATE.json'))).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.concord/\n');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('start_work');
    expect(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')).toContain(
      `"CONCORD_REPO_ROOT": "${dir}"`,
    );
  });

  it('preserves existing gitignore rules and adds the Concord entry once', () => {
    const dir = repoDir();
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules/');

    runSetup(dir, { mcp: false });
    runSetup(dir, { mcp: false });

    expect(readFileSync(gitignorePath, 'utf8')).toBe('node_modules/\n.concord/\n');
  });
});

describe('renderTasks', () => {
  it('shows a placeholder when there are no tasks', () => {
    expect(renderTasks([])).toContain('calling start_work');
  });

  it('renders a row per task', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry', agent: 'claude-code' });
    const output = renderTasks(repos.tasks.list());
    expect(output).toContain('TASK-12');
    expect(output).toContain('claude-code');
    expect(output).toContain('Retry');
    expect(output).toContain(repos.tasks.get('TASK-12')?.updatedAt ?? 'missing timestamp');
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
    expect(text).toContain(view.active[0]?.updatedAt ?? 'missing timestamp');
    expect(text).toContain('touches: billing');
    expect(text).toContain('TASK-12 <-> TASK-14');
  });

  it('annotates a subtask with its parent in the active list', () => {
    handleClaimWork(repos, {
      task_id: 'FE-1',
      title: 'Frontend',
      modules: ['app-shell'],
      agent: 'codex',
    });
    handleClaimWork(repos, {
      task_id: 'FE-1.1',
      title: 'Sub',
      parent_task_id: 'FE-1',
      modules: ['todo-ui'],
      agent: 'codex',
    });
    const text = renderStatusText(buildStatus(repos));
    expect(text).toContain('(child of FE-1)');
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

  it("includes the presence roster and renders a Who's here section", () => {
    handleRegisterAgent(repos, {
      agent_id: 'claude-code:7p8v',
      kind: 'claude-code',
      summary: 'building frontend',
    });
    const view = buildStatus(repos);
    expect(view.presence).toHaveLength(1);
    expect(view.presence[0]?.liveness).toBe('live');

    const text = renderStatusText(view);
    expect(text).toContain("Who's here");
    expect(text).toContain('claude-code:7p8v');
    expect(text).toContain('building frontend');
  });

  it("shows Who's here / none when no agent has registered", () => {
    expect(renderStatusText(buildStatus(repos))).toContain("Who's here\n  none");
  });

  it('flags a stale claim once its owning agent has gone away', () => {
    handleRegisterAgent(repos, { agent_id: 'claude-code:7p8v', kind: 'claude-code' });
    handleClaimWork(repos, {
      task_id: 'TASK-42',
      title: 'Retry',
      modules: ['billing'],
      agent_id: 'claude-code:7p8v',
    });

    // Fresh: nothing stale yet.
    expect(buildStatus(repos).staleClaims).toEqual([]);

    // 31 minutes later the agent is past the away threshold.
    const later = Date.now() + 31 * 60 * 1000;
    const view = buildStatus(repos, later);
    expect(view.staleClaims).toHaveLength(1);
    expect(view.staleClaims[0]?.taskId).toBe('TASK-42');

    const text = renderStatusText(view);
    expect(text).toContain('Stale claims');
    expect(text).toContain('TASK-42');
    expect(text).toContain('claude-code:7p8v');
  });
});

describe('runWho', () => {
  it('lists agents registered in the workspace', () => {
    const dir = repoDir();
    runSetup(dir, { mcp: false });
    handleRegisterAgent(openContext(dir).repos, {
      agent_id: 'claude-code:7p8v',
      kind: 'claude-code',
      summary: 'building frontend',
    });
    const out = runWho(dir);
    expect(out).toContain("Who's here");
    expect(out).toContain('claude-code:7p8v');
    expect(out).toContain('building frontend');
  });

  it('shows none when nobody has registered', () => {
    const dir = repoDir();
    runSetup(dir, { mcp: false });
    expect(runWho(dir)).toContain('none');
  });
});

describe('CLI workspace selection', () => {
  it('uses the same CONCORD_REPO_ROOT override as MCP resolution', () => {
    const selected = repoDir();
    const elsewhere = repoDir();
    const context = openContext(elsewhere, { CONCORD_REPO_ROOT: selected });

    expect(context.repoRoot).toBe(selected);
    expect(context.workspaceId).toBe(workspaceIdForRoot(selected));
  });

  it('configures an explicit --repo from any launch directory', () => {
    const selected = repoDir();
    const elsewhere = repoDir();
    const env: NodeJS.ProcessEnv = {};
    const identity = configureCliWorkspace({ repo: selected }, elsewhere, env);

    expect(identity).toEqual({
      workspaceId: workspaceIdForRoot(selected),
      repoRoot: selected,
    });
    expect(openContext(elsewhere, env).repoRoot).toBe(selected);
  });

  it('selects the MCP workspace id through --workspace', () => {
    const selected = repoDir();
    const elsewhere = repoDir();
    const env: NodeJS.ProcessEnv = {};
    const workspaceId = workspaceIdForRoot(selected);

    expect(configureCliWorkspace({ workspace: workspaceId }, elsewhere, env)?.repoRoot).toBe(
      selected,
    );
    expect(openContext(elsewhere, env).workspaceId).toBe(workspaceId);
  });

  it('rejects conflicting CLI selectors', () => {
    const selected = repoDir();
    expect(() =>
      configureCliWorkspace(
        { repo: selected, workspace: workspaceIdForRoot(selected) },
        selected,
        {},
      ),
    ).toThrow(/either --repo or --workspace/u);
  });
});
