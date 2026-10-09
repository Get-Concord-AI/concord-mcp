import type { Command } from '@commander-js/extra-typings';

import { buildStatus, renderStatusText } from '../../artifacts/work-state-view.js';
import { openContext } from '../context.js';
import { inCloud, runCloudStatus } from './cloud-views.js';

export function runStatus(cwd: string): string {
  const context = openContext(cwd);
  return [
    `Workspace: ${context.workspaceId} (${context.repoRoot})`,
    renderStatusText(buildStatus(context.repos)),
  ].join('\n');
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show active work, overlaps, and review-ready tasks')
    .action(async () => {
      const cloud = await inCloud(process.cwd(), runCloudStatus);
      process.stdout.write(`${cloud ?? runStatus(process.cwd())}\n`);
    });
}
