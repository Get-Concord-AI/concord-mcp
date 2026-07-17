import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from '@commander-js/extra-typings';

import { writeArtifacts } from '../../artifacts/index.js';
import { openContext } from '../context.js';

const ARTIFACT_FILES = ['HANDOFF.md', 'REVIEW_PACKET.md', 'WORK_STATE.json', 'events.jsonl'];

/** Regenerate the markdown/JSON artifacts and return the files that now exist. */
export function runExportMarkdown(cwd: string): string[] {
  const ctx = openContext(cwd);
  writeArtifacts(ctx.concordPath, ctx.repos);
  return ARTIFACT_FILES.filter((file) => existsSync(join(ctx.concordPath, file)));
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .argument('[format]', 'export format', 'markdown')
    .description('Regenerate .concord/ artifacts from the database')
    .action((format) => {
      if (format !== 'markdown') {
        process.stderr.write(
          `Unsupported export format: ${format}. Only "markdown" is supported.\n`,
        );
        process.exitCode = 1;
        return;
      }
      const written = runExportMarkdown(process.cwd());
      process.stdout.write(`Wrote ${String(written.length)} artifact(s): ${written.join(', ')}\n`);
    });
}
