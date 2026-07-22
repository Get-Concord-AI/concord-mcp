import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

import { migrations } from '../../db/schema.js';
import { buildAdoption } from '../../domain/adoption.js';
import { openContext, type CliContext } from '../context.js';

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no ';
}

/** Produce a human-readable diagnostics report for the workspace. */
export function buildDoctorReport(ctx: CliContext): string {
  const dbPath = join(ctx.concordPath, 'concord.db');
  const schemaVersion = z.number().parse(ctx.repos.db.pragma('user_version', { simple: true }));
  const tasks = ctx.repos.tasks.list();
  const events = ctx.repos.events.list();
  const adoption = buildAdoption(events);

  const lines = [
    'Concord doctor',
    '',
    'Workspace',
    `  .concord/    ${existsSync(ctx.concordPath) ? 'ok' : 'missing'}  ->  ${ctx.concordPath}`,
    `  concord.db   ${existsSync(dbPath) ? 'ok' : 'missing'} (schema v${String(schemaVersion)}, expected v${String(migrations.length)})`,
    `  repo root    ${ctx.repoRoot}`,
    '',
    'Activity',
    `  tasks: ${String(tasks.length)}`,
    `  events: ${String(events.length)}`,
    '',
    'Adoption',
  ];

  if (adoption.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of adoption) {
      lines.push(
        `  ${entry.taskId.padEnd(10)} claim_work: ${yesNo(entry.claimWork)}  handoff: ${yesNo(entry.handoff)}  review_ready: ${yesNo(entry.reviewReady)}`,
      );
    }
  }

  return lines.join('\n');
}

export function runDoctor(cwd: string): string {
  return buildDoctorReport(openContext(cwd));
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check the workspace and report tool adoption')
    .action(() => {
      process.stdout.write(`${runDoctor(process.cwd())}\n`);
    });
}
