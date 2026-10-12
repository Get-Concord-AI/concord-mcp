import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

import { migrations } from '../../db/schema.js';
import { buildAdoption } from '../../domain/adoption.js';
import { BLOCK_END, BLOCK_START } from '../../install/block.js';
import { INSTRUCTION_TARGETS } from '../../install/index.js';
import { renderAdapterReport, statusGlobalAdapters } from '../../install/adapters/index.js';
import { CONCORD_INSTRUCTION_VERSION } from '../../install/instructions.js';
import { endpointPromptable } from '../../tools/agent-messages.js';
import { openContext, type CliContext } from '../context.js';

/** Summarize outdated or unreadable generated Concord instruction blocks. */
function instructionStatus(repoRoot: string): string {
  const marker = `<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->`;
  const issues = INSTRUCTION_TARGETS.flatMap((target) => {
    const relativePath = target.relPath;
    const path = join(repoRoot, relativePath);
    if (!existsSync(path)) {
      return [];
    }
    try {
      const content = readFileSync(path, 'utf8');
      const blockStart = content.indexOf(BLOCK_START);
      const blockEnd = content.indexOf(BLOCK_END, blockStart + BLOCK_START.length);
      const isStale =
        blockStart >= 0 && blockEnd >= 0
          ? !content.slice(blockStart, blockEnd + BLOCK_END.length).includes(marker)
          : false;
      return isStale ? [`stale -> ${relativePath}`] : [];
    } catch {
      return [`unreadable -> ${relativePath}`];
    }
  });
  return issues.join('; ') || 'ok';
}

/** Produce a human-readable diagnostics report for the workspace. */
export function buildDoctorReport(ctx: CliContext, env: NodeJS.ProcessEnv = process.env): string {
  const schemaVersion = z.number().parse(ctx.repos.db.pragma('user_version', { simple: true }));
  const tasks = ctx.repos.tasks.list();
  const events = ctx.repos.events.list();
  const adoption = buildAdoption(events);
  const instructions = instructionStatus(ctx.repoRoot);
  const endpoints = ctx.repos.agentEndpoints.list();
  const connectedEndpoints = endpoints.filter((endpoint) => endpointPromptable(endpoint));

  const lines = [
    'Concord doctor',
    '',
    'Workspace',
    `  workspace id ${ctx.workspaceId}`,
    `  store        ${ctx.store.kind}${ctx.store.kind === 'global' ? ` (project ${ctx.store.project})` : ''}`,
    `  .concord/    ${existsSync(ctx.concordPath) ? 'ok' : 'missing'}  ->  ${ctx.concordPath}`,
    `  concord.db   ${existsSync(ctx.store.databasePath) ? 'ok' : 'missing'} (schema v${String(schemaVersion)}, expected v${String(migrations.length)})`,
    `  repo root    ${ctx.repoRoot}`,
    `  instructions ${instructions}`,
    `  endpoints    ${String(connectedEndpoints.length)} reachable / ${String(endpoints.length)} registered`,
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
        `  ${entry.taskId.padEnd(10)} start_work: ${entry.startWork ? 'yes' : 'no'}  finish_work: ${entry.finishWork ? 'yes' : 'no'}  review_ready: ${entry.reviewReady ? 'yes' : 'no'}`,
      );
    }
  }

  return `${lines.join('\n')}\n\n${renderAdapterReport(statusGlobalAdapters(env, ctx.repoRoot))}`;
}

export function runDoctor(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return buildDoctorReport(openContext(cwd, env), env);
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check the workspace and report tool adoption')
    .action(() => {
      process.stdout.write(`${runDoctor(process.cwd())}\n`);
    });
}
