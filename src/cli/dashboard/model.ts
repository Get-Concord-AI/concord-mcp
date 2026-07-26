import { basename, dirname } from 'node:path';

import { buildStatus, type StatusView } from '../../artifacts/work-state-view.js';
import type {
  EventRecord,
  HandoffRecord,
  Repositories,
  ReviewRecord,
  TaskRecord,
  TaskUpdateRecord,
} from '../../db/index.js';

export interface DashboardTask {
  task: TaskRecord;
  touches: string;
  updates: TaskUpdateRecord[];
  latestHandoff: HandoffRecord | undefined;
  latestReview: ReviewRecord | undefined;
}

export interface DashboardSnapshot {
  repoName: string;
  generatedAt: string;
  status: StatusView;
  tasks: DashboardTask[];
  events: EventRecord[];
}

function touchesOf(task: TaskRecord): string {
  const values =
    task.modules.length > 0 ? task.modules : task.expectedFiles.map((file) => dirname(file));
  const unique = [...new Set(values.filter((value) => value !== '.' && value !== ''))];
  return unique.length > 0 ? unique.join(', ') : '-';
}

/** Build the complete read-only projection consumed by the live dashboard. */
export function buildDashboardSnapshot(
  repoRoot: string,
  repos: Repositories,
  now: number = Date.now(),
): DashboardSnapshot {
  const tasks = repos.tasks
    .list()
    .map((task) => ({
      task,
      touches: touchesOf(task),
      updates: repos.taskUpdates.listByTask(task.taskId),
      latestHandoff: repos.handoffs.latestForTask(task.taskId),
      latestReview: repos.reviews.latestForTask(task.taskId),
    }))
    .sort(
      (a, b) =>
        b.task.updatedAt.localeCompare(a.task.updatedAt) ||
        b.task.taskId.localeCompare(a.task.taskId),
    );

  return {
    repoName: basename(repoRoot),
    generatedAt: new Date(now).toISOString(),
    status: buildStatus(repos, now),
    tasks,
    events: repos.events.list().slice(-100).reverse(),
  };
}
