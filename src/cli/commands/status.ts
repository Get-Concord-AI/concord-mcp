import { dirname } from 'node:path';

import type { Command } from '@commander-js/extra-typings';

import type { Repositories, TaskRecord } from '../../db/index.js';
import { detectOverlaps } from '../../domain/overlap.js';
import { openContext } from '../context.js';

interface ActiveEntry {
  taskId: string;
  agent: string;
  branch: string;
  touches: string;
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

export interface StatusView {
  active: ActiveEntry[];
  overlaps: OverlapPair[];
  reviewReady: ReviewEntry[];
  openQuestions: OpenQuestionEntry[];
}

function touchesOf(task: TaskRecord): string {
  const values = task.modules.length > 0 ? task.modules : task.expectedFiles.map((f) => dirname(f));
  const unique = [...new Set(values.filter((v) => v !== '.' && v !== ''))];
  return unique.length > 0 ? unique.join(', ') : '-';
}

export function buildStatus(repos: Repositories): StatusView {
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
    })),
    overlaps,
    reviewReady,
    openQuestions,
  };
}

export function renderStatusText(view: StatusView): string {
  const lines = ['Concord workspace', '', 'Active work'];
  if (view.active.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of view.active) {
      lines.push(
        `  ${entry.taskId.padEnd(10)} ${entry.agent.padEnd(12)} ${entry.branch.padEnd(20)} touches: ${entry.touches}`,
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

export function runStatus(cwd: string): string {
  return renderStatusText(buildStatus(openContext(cwd).repos));
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show active work, overlaps, and review-ready tasks')
    .action(() => {
      process.stdout.write(`${runStatus(process.cwd())}\n`);
    });
}
