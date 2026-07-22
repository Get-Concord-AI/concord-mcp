import type { Command } from '@commander-js/extra-typings';

import { buildStatus, renderStatusText } from '../../artifacts/work-state-view.js';
import { openContext } from '../context.js';

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
