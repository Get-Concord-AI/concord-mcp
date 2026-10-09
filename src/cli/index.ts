#!/usr/bin/env node
import { Command } from '@commander-js/extra-typings';
import { performance } from 'node:perf_hooks';

import { resolveRepoRoot } from '../config/paths.js';
import { createTelemetryClient } from '../telemetry/client.js';
import { VERSION } from '../version.js';
import { registerCheckCommand } from './commands/check.js';
import { cloudLinked } from './commands/cloud-inbox.js';
import { registerCloudCommand } from './commands/cloud.js';
import { registerAdaptersCommand } from './commands/adapters.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerExportCommand } from './commands/export.js';
import { registerHandoffCommand } from './commands/handoff.js';
import { registerHookCommand } from './commands/hook.js';
import { registerInboxCommand } from './commands/inbox.js';
import { registerReviewPacketCommand } from './commands/review-packet.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerStatus } from './commands/status.js';
import { registerTasks } from './commands/tasks.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerWhoCommand } from './commands/who.js';
import { notifyIfUpdateAvailable } from '../update-notifier.js';
import { configureCliWorkspace, parseCliWorkspaceOptions } from './workspace-options.js';

const program = new Command();
let workspaceRoot = resolveRepoRoot(process.cwd(), process.env);
let activeCommand: { name: string; startedAt: number } | undefined;
const backgroundCommands = new Set(['drain', 'watch', 'hook']);
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
  const options = parseCliWorkspaceOptions(command.opts());
  const selected = configureCliWorkspace(options, process.cwd(), process.env);
  if (selected !== undefined) {
    workspaceRoot = selected.repoRoot;
    process.stderr.write(`Concord workspace: ${selected.workspaceId} (${selected.repoRoot})\n`);
  }
  // `concord cloud …` acts on Concord Cloud, which records its own usage; the
  // open-source CLI emits no telemetry, success or error, for non-local
  // operations. Checked by parent, since `cloud status` shares its name with
  // the local `status`. The inbox in a cloud-linked repository is the cloud's
  // too.
  const parent = actionCommand.parent?.name();
  const nonLocal = parent === 'cloud' || (parent === 'inbox' && cloudLinked(workspaceRoot));
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

registerSetupCommand(program);
registerAdaptersCommand(program);
registerStatus(program);
registerWhoCommand(program);
registerTasks(program);
registerCheckCommand(program);
registerDashboardCommand(program);
registerWatchCommand(program);
registerHookCommand(program, telemetry);
registerInboxCommand(program, telemetry);
registerHandoffCommand(program);
registerReviewPacketCommand(program);
registerExportCommand(program);
registerDoctorCommand(program);
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
  throw error;
} finally {
  await telemetry?.close();
}
