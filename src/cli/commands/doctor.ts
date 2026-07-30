import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

import { migrations } from '../../db/schema.js';
import { buildAdoption } from '../../domain/adoption.js';
import { BLOCK_END, BLOCK_START } from '../../install/block.js';
import { CONCORD_INSTRUCTION_VERSION } from '../../install/instructions.js';
import { openContext, type CliContext } from '../context.js';

const instructionTargets = [
  'CLAUDE.md',
  'AGENTS.md',
  join('.codex', 'concord.md'),
  join('.cursor', 'rules', 'concord.mdc'),
] as const;

export interface InstructionIssues {
  stale: string[];
  unreadable: string[];
}

/** Inspect generated Concord blocks without letting malformed paths break doctor. */
export function findInstructionIssues(repoRoot: string): InstructionIssues {
  const marker = `<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->`;
  const stale: string[] = [];
  const unreadable: string[] = [];
  for (const relativePath of instructionTargets) {
    const path = join(repoRoot, relativePath);
    if (!existsSync(path)) {
      continue;
    }
    try {
      if (!statSync(path).isFile()) {
        unreadable.push(relativePath);
        continue;
      }
      const content = readFileSync(path, 'utf8');
      const blockStart = content.indexOf(BLOCK_START);
      const blockEnd = content.indexOf(BLOCK_END, blockStart + BLOCK_START.length);
      const concordBlock =
        blockStart >= 0 && blockEnd >= 0
          ? content.slice(blockStart, blockEnd + BLOCK_END.length)
          : undefined;
      if (concordBlock !== undefined && !concordBlock.includes(marker)) {
        stale.push(relativePath);
      }
    } catch {
      unreadable.push(relativePath);
    }
  }
  return { stale, unreadable };
}

/** Find installed Concord instruction blocks that predate the current workflow contract. */
export function findStaleInstructionFiles(repoRoot: string): string[] {
  return findInstructionIssues(repoRoot).stale;
}

/** Produce a human-readable diagnostics report for the workspace. */
export function buildDoctorReport(ctx: CliContext): string {
  const dbPath = join(ctx.concordPath, 'concord.db');
  const schemaVersion = z.number().parse(ctx.repos.db.pragma('user_version', { simple: true }));
  const tasks = ctx.repos.tasks.list();
  const events = ctx.repos.events.list();
  const adoption = buildAdoption(events);
  const instructionIssues = findInstructionIssues(ctx.repoRoot);
  const instructionStatus = [
    instructionIssues.stale.length > 0
      ? `stale -> ${instructionIssues.stale.join(', ')}`
      : undefined,
    instructionIssues.unreadable.length > 0
      ? `unreadable -> ${instructionIssues.unreadable.join(', ')}`
      : undefined,
  ]
    .filter((entry) => entry !== undefined)
    .join('; ');

  const lines = [
    'Concord doctor',
    '',
    'Workspace',
    `  workspace id ${ctx.workspaceId}`,
    `  .concord/    ${existsSync(ctx.concordPath) ? 'ok' : 'missing'}  ->  ${ctx.concordPath}`,
    `  concord.db   ${existsSync(dbPath) ? 'ok' : 'missing'} (schema v${String(schemaVersion)}, expected v${String(migrations.length)})`,
    `  repo root    ${ctx.repoRoot}`,
    `  instructions ${instructionStatus === '' ? 'ok' : instructionStatus}`,
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
        `  ${entry.taskId.padEnd(10)} claim_work: ${entry.claimWork ? 'yes' : 'no'}  handoff: ${entry.handoff ? 'yes' : 'no'}  review_ready: ${entry.reviewReady ? 'yes' : 'no'}`,
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
