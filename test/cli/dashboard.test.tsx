import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import { DashboardApp } from '../../src/cli/dashboard/app.js';
import { buildDashboardSnapshot } from '../../src/cli/dashboard/model.js';
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

  it('renders a wide overview and task context', () => {
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
    const frame = view.lastFrame();

    expect(frame).toContain('Concord · concord-demo · LIVE');
    expect(frame).toContain('Agents');
    expect(frame).toContain('claude-code:demo');
    expect(frame).toContain('TASK-12');
    expect(frame).toContain('TASK-12 ↔ TASK-14');
    expect(frame).toContain('Timeline');

    view.stdin.write('j');
    expect(view.lastFrame()).toContain('Use a queued retry');
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

  it('filters tasks and exposes keyboard help', () => {
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
    expect(view.lastFrame()).toContain('TASK-14');
    expect(view.lastFrame()).not.toContain('TASK-12 — Add Stripe retry handling');

    view.stdin.write('\u001B');
    view.stdin.write('?');
    expect(view.lastFrame()).toContain('Keyboard help');
    expect(view.lastFrame()).toContain('Tab/Shift-Tab');
  });

  it('refreshes immediately when r is pressed', () => {
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
    expect(view.lastFrame()).toContain('TASK-99');
  });

  it('keeps a fixed viewport as the roster grows', () => {
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

    expect(view.lastFrame()?.split('\n')).toHaveLength(initialHeight);
    expect(initialHeight).toBe(24);
  });
});
