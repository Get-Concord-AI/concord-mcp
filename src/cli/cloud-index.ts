#!/usr/bin/env node
import { Command } from '@commander-js/extra-typings';
import { performance } from 'node:perf_hooks';

import { linkedMachine } from '../cloud/target.js';
import type { CloudRuntime } from '../cloud/runtime.js';
import { resolveRepoRoot } from '../config/paths.js';
import { createTelemetryClient } from '../telemetry/client.js';
import { notifyIfUpdateAvailable } from '../update-notifier.js';
import { VERSION } from '../version.js';
import { configureCliWorkspace, parseCliWorkspaceOptions } from './workspace-options.js';
import { cloudAccess } from './commands/cloud-inbox.js';
import { registerAdaptersCommand } from './commands/adapters.js';
import { registerCloudCompatibleCommands } from './commands/cloud-compatible.js';
import {
  CLOUD_EXPORT_MESSAGE,
  runCloudStatus,
  runCloudTasks,
  runCloudWho,
} from './commands/cloud-views.js';
import { registerCloudCommand } from './commands/cloud.js';
import { registerHookCommand } from './commands/hook.js';
import { registerInboxCommand } from './commands/inbox.js';

function cloudRuntime(): CloudRuntime {
  const access = cloudAccess(process.cwd());
  if (access.kind === 'cloud') return access.runtime;
  if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
  if (linkedMachine(process.env) !== undefined)
    throw new Error(
      'This machine is linked to Concord Cloud, but this repository has no usable cloud workspace.',
    );
  throw new Error('This command is available only when the repository is linked to Concord Cloud.');
}

const program = new Command();
let workspaceRoot = resolveRepoRoot(process.cwd(), process.env);
let activeCommand: { name: string; startedAt: number } | undefined;
const backgroundCommands = new Set(['drain', 'watch', 'hook']);
const CLOUD_SERVED = new Set(['status', 'who', 'tasks', 'export']);
const telemetry = createTelemetryClient({
  surface: 'cli',
  workspaceRoot: () => workspaceRoot,
});

program
  .name('concord')
  .description('Shared work-state for coding agents')
  .version(VERSION)
  .option('-C, --repo <path>', 'use the Concord workspace for this repository path')
  .option('--workspace <id>', 'use a workspace id returned by a Concord operation');

program.hook('preAction', (command, actionCommand) => {
  const selected = configureCliWorkspace(
    parseCliWorkspaceOptions(command.opts()),
    process.cwd(),
    process.env,
  );
  if (selected !== undefined) {
    workspaceRoot = selected.repoRoot;
    process.stderr.write(`Concord workspace: ${selected.workspaceId} (${selected.repoRoot})\n`);
  }
  const parent = actionCommand.parent?.name();
  const nonLocal =
    parent === 'cloud' ||
    ((parent === 'inbox' || CLOUD_SERVED.has(actionCommand.name())) &&
      linkedMachine(process.env) !== undefined);
  activeCommand = nonLocal
    ? undefined
    : { name: actionCommand.name(), startedAt: performance.now() };
});

program.hook('postAction', (_command, actionCommand) => {
  if (activeCommand?.name === actionCommand.name()) {
    if (!backgroundCommands.has(activeCommand.name)) {
      telemetry?.recordOperation(
        activeCommand.name,
        'success',
        performance.now() - activeCommand.startedAt,
      );
    }
    activeCommand = undefined;
  }
});

program
  .command('status')
  .description('Show active work, overlaps, and review-ready tasks')
  .action(async () => {
    process.stdout.write(`${await runCloudStatus(cloudRuntime())}\n`);
  });

program
  .command('who')
  .description('Show which agents are present and what they are working on')
  .action(async () => {
    process.stdout.write(`${await runCloudWho(cloudRuntime())}\n`);
  });

program
  .command('tasks')
  .description('List all tasks Concord is tracking')
  .action(async () => {
    process.stdout.write(`${await runCloudTasks(cloudRuntime())}\n`);
  });

program
  .command('export')
  .argument('[format]', 'export format', 'markdown')
  .description('Regenerate .concord/ artifacts from the database')
  .action((format) => {
    if (format !== 'markdown') {
      process.stderr.write(`Unsupported export format: ${format}. Only "markdown" is supported.\n`);
    } else {
      process.stderr.write(`${CLOUD_EXPORT_MESSAGE}\n`);
    }
    process.exitCode = 1;
  });

registerHookCommand(program, telemetry);
registerInboxCommand(program, telemetry);
registerAdaptersCommand(program);
registerCloudCompatibleCommands(program);
registerCloudCommand(program);

try {
  await notifyIfUpdateAvailable(VERSION);
  await program.parseAsync();
} catch (error) {
  if (activeCommand !== undefined) {
    if (!backgroundCommands.has(activeCommand.name)) {
      telemetry?.recordOperation(
        activeCommand.name,
        'error',
        performance.now() - activeCommand.startedAt,
      );
    }
  }
  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }
  process.exitCode = 1;
} finally {
  await telemetry?.close();
}
