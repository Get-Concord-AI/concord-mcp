import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

import { migrations } from '../../db/schema.js';
import { buildAdoption } from '../../domain/adoption.js';
import { BLOCK_END, BLOCK_START } from '../../install/block.js';
import {
  adapterNeedsAttention,
  renderAdapterReport,
  statusGlobalAdapters,
  type AdapterReport,
} from '../../install/adapters/index.js';
import {
  brokenAdapterLinks,
  isEphemeralPath,
  linkNeedsRepair,
  repairAdapterLinks,
  type EphemeralTest,
  type LinkRepair,
} from '../../install/adapters/links.js';
import { CONCORD_INSTRUCTION_VERSION } from '../../install/instructions.js';
import { endpointPromptable } from '../../tools/agent-messages.js';
import { linkedMachine } from '../../cloud/target.js';
import { resolveRepoRoot } from '../../config/paths.js';
import { gitOriginRemote } from '../../workspaces/store.js';
import { openContext, type CliContext } from '../context.js';
import { buildCloudDoctorReport, type Leftover } from './doctor-cloud.js';
import { askQuestion } from './setup.js';

const instructionTargets = [
  'CLAUDE.md',
  'AGENTS.md',
  join('.codex', 'concord.md'),
  join('.cursor', 'rules', 'concord.mdc'),
  join('.agents', 'rules', 'concord.md'),
] as const;

/** Summarize outdated or unreadable generated Concord instruction blocks. */
function instructionStatus(repoRoot: string): string {
  const marker = `<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->`;
  const issues = instructionTargets.flatMap((relativePath) => {
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
export function buildDoctorReport(
  ctx: CliContext,
  env: NodeJS.ProcessEnv = process.env,
  adapters: readonly AdapterReport[] = statusGlobalAdapters(env, ctx.repoRoot),
): string {
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

  return `${lines.join('\n')}\n\n${renderAdapterReport(adapters)}`;
}

export interface DoctorOptions {
  /** Re-point broken adapter links without asking. */
  fix?: boolean | undefined;
  /** On a linked machine, move unused local state aside without asking. */
  cleanLocal?: boolean | undefined;
  /** Ask before moving unused local state aside; undefined when there is no terminal to ask on. */
  confirmCleanup?: ((leftovers: readonly Leftover[]) => Promise<boolean>) | undefined;
  /** Ask before repairing; undefined when there is no terminal to ask on. */
  confirm?: ((repairs: readonly LinkRepair[]) => Promise<boolean>) | undefined;
  moduleUrl?: string | undefined;
  isEphemeral?: EphemeralTest | undefined;
}

export interface DoctorResult {
  output: string;
  healthy: boolean;
}

/** Diagnose the workspace, repairing broken adapter links first when asked to. */
export async function runDoctorCommand(
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const isEphemeral = options.isEphemeral ?? isEphemeralPath;
  const broken = brokenAdapterLinks(moduleUrl, env, isEphemeral);
  const preface: string[] = [];
  if (broken.length > 0) {
    const approved =
      options.fix === true || (options.confirm !== undefined && (await options.confirm(broken)));
    if (approved) preface.push(renderRepairs(repairAdapterLinks(moduleUrl, env, isEphemeral)), '');
  }
  const repoRoot = resolveRepoRoot(cwd, env);
  const adapters = statusGlobalAdapters(env, repoRoot, moduleUrl, isEphemeral);
  if (options.fix === true && broken.length === 0) {
    const stillBroken = adapters.some(
      (entry) => entry.link !== undefined && linkNeedsRepair(entry.link, isEphemeral),
    );
    preface.push(
      stillBroken
        ? 'Broken adapter links cannot be repaired from a temporary copy of Concord. ' +
            'Run `concord doctor --fix` from the installed package.'
        : 'No adapter links need repair.',
      '',
    );
  }
  const adaptersHealthy = !adapters.some(adapterNeedsAttention);

  if (linkedMachine(env) !== undefined) {
    const cloud = await buildCloudDoctorReport(cwd, env, {
      fetch,
      originRemote: gitOriginRemote,
      cleanLocal: (leftovers) =>
        options.cleanLocal === true
          ? Promise.resolve(true)
          : (options.confirmCleanup?.(leftovers) ?? Promise.resolve(false)),
    });
    return {
      output: [...preface, cloud.output, '', renderAdapterReport(adapters)].join('\n'),
      healthy: cloud.healthy && adaptersHealthy,
    };
  }

  let ctx: CliContext;
  try {
    ctx = openContext(cwd, env);
  } catch (error) {
    // A store this build cannot migrate (one a development build changed, say)
    // is a finding to report, not a crash.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      output: [
        ...preface,
        'Concord doctor',
        '',
        `Workspace\n  store        unreadable: ${reason}`,
        '  Move the store aside to start a fresh one; its tasks stay in the moved file.',
        '',
        renderAdapterReport(adapters),
      ].join('\n'),
      healthy: false,
    };
  }
  return {
    output: [...preface, buildDoctorReport(ctx, env, adapters)].join('\n'),
    healthy: adaptersHealthy,
  };
}

export function runDoctor(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return buildDoctorReport(openContext(cwd, env), env);
}

function renderRepairs(repairs: readonly LinkRepair[]): string {
  return repairs
    .map((repair) => `Repaired ${repair.harness}: ${repair.target} -> ${repair.to}`)
    .join('\n');
}

/** Yes by default; no answer leaves the links as they are. */
/** No by default: moving state aside is the user's call. */
async function confirmCleanup(leftovers: readonly Leftover[]): Promise<boolean> {
  const lines = leftovers.map((leftover) => `  ${leftover.path}`);
  process.stdout.write(
    `This machine is linked to Concord Cloud, so this local state is unused:\n${lines.join('\n')}\n`,
  );
  const answer = await askQuestion('Move it aside (nothing is deleted)? [y/N] ');
  return answer !== undefined && /^(?:y|yes)$/iu.test(answer.trim());
}

async function confirmRepair(repairs: readonly LinkRepair[]): Promise<boolean> {
  const lines = repairs.map(
    (repair) => `  ${repair.harness}: ${repair.target} -> ${repair.from ?? '(none)'}`,
  );
  process.stdout.write(`Broken Concord adapter links:\n${lines.join('\n')}\n`);
  const answer = await askQuestion('Re-point them at this installed package? [Y/n] ');
  return answer !== undefined && !/^(?:n|no)$/iu.test(answer.trim());
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check the workspace, or the Concord Cloud link, and report tool adoption')
    .option('--fix', 'Re-point broken harness adapter links at this installed package')
    .option(
      '--clean-local',
      'On a machine linked to Concord Cloud, move unused local Concord state aside',
    )
    .action(async (options) => {
      const interactive = process.stdin.isTTY && process.stdout.isTTY;
      const result = await runDoctorCommand(process.cwd(), process.env, {
        fix: options.fix,
        cleanLocal: options.cleanLocal,
        confirm: interactive ? confirmRepair : undefined,
        confirmCleanup: interactive ? confirmCleanup : undefined,
      });
      process.stdout.write(`${result.output}\n`);
      if (!result.healthy) process.exitCode = 1;
    });
}
