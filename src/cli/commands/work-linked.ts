import type { Command } from '@commander-js/extra-typings';

import { LINKED_MACHINE_MESSAGE } from '../../cloud/target.js';

/**
 * `concord work` on a linked machine. The real command runs the workflow tools
 * against the local store, so a linked machine answers with the same JSON error
 * the local command gives there, without loading that store.
 */
export function registerLinkedWorkCommand(program: Command): void {
  program
    .command('work')
    .description('Run a Concord workflow tool from the shell (local stores only)')
    .argument('[action]')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      process.stdout.write(`${JSON.stringify({ error: LINKED_MACHINE_MESSAGE })}\n`);
      process.stderr.write(`${LINKED_MACHINE_MESSAGE}\n`);
      process.exitCode = 1;
    });
}
