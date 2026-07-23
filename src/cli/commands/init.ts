import type { Command } from '@commander-js/extra-typings';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeArtifacts } from '../../artifacts/index.js';
import { openContext } from '../context.js';

const CONCORD_GITIGNORE_ENTRY = '.concord/';

/** Ensure Concord's generated workspace is ignored without changing other rules. */
export function ensureConcordIgnored(repoRoot: string): void {
  const gitignorePath = join(repoRoot, '.gitignore');
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const entries = current.split(/\r?\n/u).map((line) => line.trim());
  if (entries.includes(CONCORD_GITIGNORE_ENTRY)) {
    return;
  }

  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${current}${separator}${CONCORD_GITIGNORE_ENTRY}\n`);
}

/** Create the local `.concord/` workspace and return its path. */
export function runInit(cwd: string): string {
  const ctx = openContext(cwd);
  ensureConcordIgnored(ctx.repoRoot);
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
