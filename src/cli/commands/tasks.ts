import type { Command } from '@commander-js/extra-typings';

import type { TaskRecord } from '../../db/index.js';
import { openContext } from '../context.js';

/** Render the full task list as a padded table (or a placeholder when empty). */
export function renderTasks(tasks: readonly TaskRecord[]): string {
  if (tasks.length === 0) {
    return 'No tasks yet. Agents create tasks by calling start_work.';
  }
  return tasks
    .map((task) => {
      const id = task.taskId.padEnd(10);
      const status = task.status.padEnd(13);
      const agent = (task.agentId ?? task.assignedAgentId ?? task.agent ?? '-').padEnd(18);
      return `${id} ${status} v${String(task.version).padEnd(4)} ${agent} ${task.title}`;
    })
    .join('\n');
}

export function runTasks(cwd: string): string {
  const context = openContext(cwd);
  return [
    `Workspace: ${context.workspaceId} (${context.repoRoot})`,
    renderTasks(context.repos.tasks.list()),
  ].join('\n');
}

export function registerTasks(program: Command): void {
  program
    .command('tasks')
    .description('List all tasks Concord is tracking')
    .action(() => {
      process.stdout.write(`${runTasks(process.cwd())}\n`);
    });
}
