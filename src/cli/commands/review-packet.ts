import type { Command } from '@commander-js/extra-typings';

import { renderReviewPacketMarkdown } from '../../artifacts/index.js';
import { openContext } from '../context.js';

/** Render the latest review packet for a task as markdown, or a message. */
export function runReviewPacket(cwd: string, taskId: string): string {
  const ctx = openContext(cwd);
  const task = ctx.repos.tasks.get(taskId);
  if (task === undefined) {
    return `No task ${taskId}.`;
  }
  const review = ctx.repos.reviews.latestForTask(taskId);
  if (review === undefined) {
    return `No review packet for ${taskId}. Ask the agent to call the review_ready tool.`;
  }
  return renderReviewPacketMarkdown(task, review, ctx.repos.handoffs.latestForTask(taskId));
}

export function registerReviewPacketCommand(program: Command): void {
  program
    .command('review-packet')
    .argument('<taskId>', 'the task to show a review packet for')
    .description('Print the latest review packet for a task')
    .action((taskId) => {
      process.stdout.write(`${runReviewPacket(process.cwd(), taskId)}\n`);
    });
}
