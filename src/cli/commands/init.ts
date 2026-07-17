import type { Command } from '@commander-js/extra-typings';

import { writeArtifacts } from '../../artifacts/index.js';
import { openContext } from '../context.js';

/** Create the local `.concord/` workspace and return its path. */
export function runInit(cwd: string): string {
  const ctx = openContext(cwd);
  writeArtifacts(ctx.concordPath, ctx.repos);
  return ctx.concordPath;
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Create the local .concord/ workspace')
    .action(() => {
      const path = runInit(process.cwd());
      process.stdout.write(`Initialized Concord workspace at ${path}\n`);
    });
}
