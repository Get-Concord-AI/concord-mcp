import type { Command } from '@commander-js/extra-typings';

import { renderRosterLines } from '../../artifacts/work-state-view.js';
import { buildRoster } from '../../domain/presence.js';
import { openContext } from '../context.js';

/** Render the presence roster: who is registered and how live they are. */
export function runWho(cwd: string, now: number = Date.now()): string {
  const roster = buildRoster(openContext(cwd).repos.agents.list(), now);
  return ["Who's here", ...renderRosterLines(roster)].join('\n');
}

export function registerWhoCommand(program: Command): void {
  program
    .command('who')
    .description('Show which agents are present and what they are working on')
    .action(() => {
      process.stdout.write(`${runWho(process.cwd())}\n`);
    });
}
