import type { Command } from '@commander-js/extra-typings';

import { renderHandoffMarkdown } from '../../artifacts/index.js';
import { openContext } from '../context.js';

/** Render the latest handoff for a task as markdown, or an explanatory message. */
export function runHandoffPacket(cwd: string, taskId: string): string {
  const ctx = openContext(cwd);
  const task = ctx.repos.tasks.get(taskId);
  if (task === undefined) {
    return `No task ${taskId}.`;
  }
  const handoff = ctx.repos.handoffs.latestForTask(taskId);
  if (handoff === undefined) {
    return `No handoff recorded for ${taskId}. Ask the agent to call the handoff tool.`;
  }
  return renderHandoffMarkdown(task, handoff);
}

export function registerHandoffCommand(program: Command): void {
  program
    .command('handoff')
    .argument('<taskId>', 'the task to show a handoff for')
    .description('Print the latest handoff for a task')
    .action((taskId) => {
      process.stdout.write(`${runHandoffPacket(process.cwd(), taskId)}\n`);
    });
}
