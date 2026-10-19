import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import { DashboardApp } from '../../src/cli/dashboard/app.js';
import { buildDashboardSnapshot } from '../../src/cli/dashboard/model.js';
import type { AvailableUpdate } from '../../src/update-notifier.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleHandoff } from '../../src/tools/handoff.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import { handleReviewReady } from '../../src/tools/review-ready.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';

describe('dashboard snapshot', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  afterEach(() => {
    cleanup();
    repos.db.close();
  });

  function flushRender(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  function seedDashboard(): void {
    handleRegisterAgent(repos, {
      agent_id: 'claude-code:demo',
      kind: 'claude-code',
      summary: 'building retry handling',
    });
    handleClaimWork(repos, {
      task_id: 'TASK-12',
      title: 'Add Stripe retry handling',
      agent: 'claude-code',
      agent_id: 'claude-code:demo',
      branch: 'feat/retry',
      modules: ['billing'],
    });
    handleUpdateTask(repos, {
      task_id: 'TASK-12',
      kind: 'decision',
      content: 'Use a queued retry',
      agent: 'claude-code',
      agent_id: 'claude-code:demo',
    });
    handleClaimWork(repos, {
      task_id: 'TASK-14',
      title: 'Fix invoice totals',
      agent: 'codex',
      modules: ['billing'],
    });
  }

  it('combines presence, task memory, overlaps, and newest-first events', () => {
    seedDashboard();
    handleHandoff(repos, {
      task_id: 'TASK-12',
      status: 'done',
      what_changed: 'Queued retries',
      agent_id: 'claude-code:demo',
    });
    handleReviewReady(repos, {
      task_id: 'TASK-12',
      plan_summary: 'Keep checkout responsive',
      open_questions: ['When should we notify the owner?'],
    });

    const snapshot = buildDashboardSnapshot('/work/concord-demo', repos);
    const task = snapshot.tasks.find((item) => item.task.taskId === 'TASK-12');

    expect(snapshot.repoName).toBe('concord-demo');
    expect(snapshot.status.presence[0]?.agentId).toBe('claude-code:demo');
    expect(snapshot.status.overlaps).toHaveLength(0);
    expect(task?.updates[0]?.content).toBe('Use a queued retry');
    expect(task?.latestHandoff?.whatChanged).toBe('Queued retries');
    expect(task?.latestReview?.openQuestions).toEqual(['When should we notify the owner?']);
    expect(snapshot.events[0]?.tool).toBe('review_ready');
  });

  it('shows the age of a stale summary beside a fresh heartbeat', async () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    repos.agents.upsert(
      { agentId: 'codex:old', kind: 'codex', summary: 'old task' },
      new Date(now - 2 * 60 * 60_000).toISOString(),
    );
    repos.agents.heartbeat('codex:old', new Date(now).toISOString());
    const snapshot = buildDashboardSnapshot('/work/demo', repos, now);
    const view = render(
      <DashboardApp
        initialSnapshot={snapshot}
        loadSnapshot={() => snapshot}
        refreshMs={60_000}
        width={180}
        height={30}
      />,
    );
    await flushRender();
    expect(view.lastFrame()).toContain('summary 120m old');
  });

  it('renders a wide overview and task context', async () => {
    seedDashboard();
    const snapshot = buildDashboardSnapshot('/work/concord-demo', repos);
    const view = render(
      <DashboardApp
        initialSnapshot={snapshot}
        loadSnapshot={() => snapshot}
        refreshMs={60_000}
        width={180}
        height={30}
      />,
    );
    const frame = view.lastFrame();

    expect(frame).toContain('Concord · concord-demo · LIVE');
    expect(frame).toContain('Agents');
    expect(frame).toContain('claude-code:demo');
    expect(frame).toContain('TASK-12');
    expect(frame).toContain('TASK-12 ↔ TASK-14');
    expect(frame).toContain('Timeline');

    view.stdin.write('j');
    await flushRender();
    expect(view.lastFrame()).toContain('Use a queued retry');
    expect(view.lastFrame()).toContain('branch feat/retry');
  });

  it('uses a compact view below 70 columns', () => {
    seedDashboard();
    const snapshot = buildDashboardSnapshot('/work/concord-demo', repos);
    const view = render(
      <DashboardApp
        initialSnapshot={snapshot}
        loadSnapshot={() => snapshot}
        refreshMs={60_000}
        width={60}
        height={24}
      />,
    );
    const frame = view.lastFrame();

    expect(frame).toContain('widen for agent context');
    expect(frame).toContain('Tasks');
    expect(frame).toContain('Alerts');
    expect(frame).not.toContain('Task context');
  });

  it('keeps an available update visible without growing the viewport', async () => {
    seedDashboard();
    const snapshot = buildDashboardSnapshot('/work/concord-demo', repos);
    const updateState: { availableUpdate?: AvailableUpdate } = {};
    const view = render(
      <DashboardApp
        initialSnapshot={snapshot}
        loadSnapshot={() => snapshot}
        refreshMs={60_000}
        width={120}
        height={24}
        loadAvailableUpdate={() => updateState.availableUpdate}
      />,
    );
    expect(view.lastFrame()).not.toContain('Update available');

    updateState.availableUpdate = {
      currentVersion: '0.10.1',
      latestVersion: '0.11.0',
      command: 'npm install -g @concord-ai/concord-mcp@latest',
    };
    view.stdin.write('r');
    await flushRender();
    const frame = view.lastFrame();

    expect(frame).toContain('Update available 0.10.1 → 0.11.0');
    expect(frame).toContain('npm install -g @concord-ai/concord-mcp@latest');
    expect(frame?.split('\n')).toHaveLength(24);
  });

  it('filters tasks and exposes keyboard help', async () => {
    seedDashboard();
    const snapshot = buildDashboardSnapshot('/work/concord-demo', repos);
    const view = render(
      <DashboardApp
        initialSnapshot={snapshot}
        loadSnapshot={() => snapshot}
        refreshMs={60_000}
        width={120}
        height={30}
      />,
    );

    view.stdin.write('/');
    view.stdin.write('invoice');
    await flushRender();
    expect(view.lastFrame()).toContain('TASK-14');
    expect(view.lastFrame()).not.toContain('TASK-12 — Add Stripe retry handling');

    view.stdin.write('\r');
    await flushRender();
    view.stdin.write('?');
    await flushRender();
    expect(view.lastFrame()).toContain('Keyboard help');
    expect(view.lastFrame()).toContain('Tab/Shift-Tab');
  });

  it('refreshes immediately when r is pressed', async () => {
    seedDashboard();
    const initial = buildDashboardSnapshot('/work/concord-demo', repos);
    const view = render(
      <DashboardApp
        initialSnapshot={initial}
        loadSnapshot={() => buildDashboardSnapshot('/work/concord-demo', repos)}
        refreshMs={60_000}
        width={120}
        height={30}
      />,
    );

    handleClaimWork(repos, { task_id: 'TASK-99', title: 'New live work', agent: 'cursor' });
    expect(view.lastFrame()).not.toContain('TASK-99');
    view.stdin.write('r');
    await flushRender();
    expect(view.lastFrame()).toContain('TASK-99');
  });

  it('keeps a fixed viewport as the roster grows', async () => {
    seedDashboard();
    const initial = buildDashboardSnapshot('/work/concord-demo', repos);
    const view = render(
      <DashboardApp
        initialSnapshot={initial}
        loadSnapshot={() => buildDashboardSnapshot('/work/concord-demo', repos)}
        refreshMs={60_000}
        width={120}
        height={24}
      />,
    );
    const initialFrame = view.lastFrame();
    if (initialFrame === undefined) {
      throw new Error('Dashboard did not render an initial frame');
    }
    const initialHeight = initialFrame.split('\n').length;

    for (let index = 0; index < 20; index += 1) {
      handleRegisterAgent(repos, {
        agent_id: `codex:${String(index)}`,
        kind: 'codex',
        summary: 'Present in the repository',
      });
    }
    view.stdin.write('r');
    await flushRender();

    expect(view.lastFrame()?.split('\n')).toHaveLength(initialHeight);
    expect(initialHeight).toBe(24);
  });
});
