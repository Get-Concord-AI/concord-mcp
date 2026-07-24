import { dirname } from 'node:path';

import type { Repositories, TaskRecord } from '../db/index.js';
import { detectOverlaps } from '../domain/overlap.js';
import { buildRoster, type PresenceEntry } from '../domain/presence.js';

interface ActiveEntry {
  taskId: string;
  agent: string;
  branch: string;
  touches: string;
  parentTaskId: string | null;
}

interface OverlapPair {
  a: string;
  b: string;
  reasons: string[];
}

interface ReviewEntry {
  taskId: string;
  testsCount: number;
  guardrailsCount: number;
  openQuestionCount: number;
}

interface OpenQuestionEntry {
  taskId: string;
  question: string;
}

/** A read-only snapshot of shared work-state: active claims, overlaps computed
 * live across all active tasks, and review-ready tasks with their open
 * questions. Rendered by both the CLI (`concord status`) and the
 * `get_work_state` MCP tool / `concord://work-state` resource. */
export interface StatusView {
  active: ActiveEntry[];
  overlaps: OverlapPair[];
  reviewReady: ReviewEntry[];
  openQuestions: OpenQuestionEntry[];
  /** Registered agents with derived liveness — "who is here and what they are
   * doing", most-live first. */
  presence: PresenceEntry[];
}

function touchesOf(task: TaskRecord): string {
  const values = task.modules.length > 0 ? task.modules : task.expectedFiles.map((f) => dirname(f));
  const unique = [...new Set(values.filter((v) => v !== '.' && v !== ''))];
  return unique.length > 0 ? unique.join(', ') : '-';
}

export function buildStatus(repos: Repositories, now: number = Date.now()): StatusView {
  const tasks = repos.tasks.list();
  const active = tasks.filter((task) => task.status === 'active');

  const overlaps: OverlapPair[] = [];
  const seenPairs = new Set<string>();
  for (const task of active) {
    for (const warning of detectOverlaps(
      {
        taskId: task.taskId,
        expectedFiles: task.expectedFiles,
        modules: task.modules,
        domains: task.domains,
        riskTags: task.riskTags,
        parentTaskId: task.parentTaskId,
      },
      active,
    )) {
      const key = [task.taskId, warning.taskId].sort((x, y) => x.localeCompare(y)).join('::');
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        overlaps.push({ a: task.taskId, b: warning.taskId, reasons: warning.reasons });
      }
    }
  }

  const reviewReady: ReviewEntry[] = [];
  const openQuestions: OpenQuestionEntry[] = [];
  for (const task of tasks.filter((t) => t.status === 'review_ready')) {
    const review = repos.reviews.latestForTask(task.taskId);
    if (review === undefined) {
      continue;
    }
    reviewReady.push({
      taskId: task.taskId,
      testsCount: review.testsRun.length,
      guardrailsCount: review.guardrailsChecked.length,
      openQuestionCount: review.openQuestions.length,
    });
    for (const question of review.openQuestions) {
      openQuestions.push({ taskId: task.taskId, question });
    }
  }

  return {
    active: active.map((task) => ({
      taskId: task.taskId,
      agent: task.agent ?? '-',
      branch: task.branch ?? '-',
      touches: touchesOf(task),
      parentTaskId: task.parentTaskId,
    })),
    overlaps,
    reviewReady,
    openQuestions,
    presence: buildRoster(repos.agents.list(), now),
  };
}

/** Render the presence roster as indented lines, or a placeholder when empty. */
export function renderRosterLines(roster: readonly PresenceEntry[]): string[] {
  if (roster.length === 0) {
    return ['  none'];
  }
  return roster.map((entry) => {
    const state = `${entry.liveness}/${entry.status}`;
    const doing = entry.summary ?? '-';
    return `  ${entry.agentId.padEnd(18)} ${state.padEnd(20)} ${doing}  (${String(entry.ageSeconds)}s ago)`;
  });
}

export function renderStatusText(view: StatusView): string {
  const lines = ['Concord workspace', '', "Who's here"];
  lines.push(...renderRosterLines(view.presence));

  lines.push('', 'Active work');
  if (view.active.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of view.active) {
      const parent = entry.parentTaskId === null ? '' : `  (child of ${entry.parentTaskId})`;
      lines.push(
        `  ${entry.taskId.padEnd(10)} ${entry.agent.padEnd(12)} ${entry.branch.padEnd(20)} touches: ${entry.touches}${parent}`,
      );
    }
  }

  lines.push('', 'Potential overlaps');
  if (view.overlaps.length === 0) {
    lines.push('  none');
  } else {
    for (const overlap of view.overlaps) {
      lines.push(`  ${overlap.a} <-> ${overlap.b}: ${overlap.reasons.join('; ')}`);
    }
  }

  lines.push('', 'Review ready');
  if (view.reviewReady.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of view.reviewReady) {
      lines.push(
        `  ${entry.taskId.padEnd(10)} tests: ${String(entry.testsCount)}  guardrails: ${String(entry.guardrailsCount)}  open questions: ${String(entry.openQuestionCount)}`,
      );
    }
  }

  lines.push('', 'Open questions');
  if (view.openQuestions.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of view.openQuestions) {
      lines.push(`  ${entry.taskId}  "${entry.question}"`);
    }
  }

  return lines.join('\n');
}
