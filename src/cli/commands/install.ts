import type { Command } from '@commander-js/extra-typings';

import { findRepoRoot } from '../../config/paths.js';
import { installConcord } from '../../install/index.js';

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Write Concord usage instructions into supported client configs')
    .action(() => {
      const repoRoot = findRepoRoot(process.cwd());
      const written = installConcord(repoRoot);
      process.stdout.write(`Installed Concord instructions:\n`);
      for (const relPath of written) {
        process.stdout.write(`  ${relPath}\n`);
      }
    });
}
