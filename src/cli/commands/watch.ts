import { watch } from 'node:fs';

import type { Command } from '@commander-js/extra-typings';

import { buildStatus, renderStatusText } from '../../artifacts/work-state-view.js';
import type { Repositories } from '../../db/index.js';
import { openContext } from '../context.js';

/** Current work-state as text — what `concord watch` prints on each change. */
export function watchSnapshot(repos: Repositories): string {
  return renderStatusText(buildStatus(repos));
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Print work-state whenever .concord changes (Ctrl-C to stop)')
    .action(() => {
      const ctx = openContext(process.cwd());
      const print = (): void => {
        process.stdout.write(`${watchSnapshot(ctx.repos)}\n\n`);
      };
      print();

      // Debounce: SQLite writes touch several files (db, -wal, -shm) in quick
      // succession, so coalesce bursts into a single reprint.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(ctx.concordPath, () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        timer = setTimeout(print, 150);
      });

      process.once('SIGINT', () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        watcher.close();
      });
    });
}
