#!/usr/bin/env node
import { Command } from '@commander-js/extra-typings';
import { performance } from 'node:perf_hooks';

import { resolveRepoRoot } from '../config/paths.js';
import { createTelemetryClient } from '../telemetry/client.js';
import { VERSION } from '../version.js';
import { registerCheckCommand } from './commands/check.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerExportCommand } from './commands/export.js';
import { registerHandoffCommand } from './commands/handoff.js';
import { registerHookCommand } from './commands/hook.js';
import { registerInit } from './commands/init.js';
import { registerInstallCommand } from './commands/install.js';
import { registerReviewPacketCommand } from './commands/review-packet.js';
import { registerStatus } from './commands/status.js';
import { registerTasks } from './commands/tasks.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerWhoCommand } from './commands/who.js';
import { notifyIfUpdateAvailable } from './update-notifier.js';

const program = new Command();
let activeCommand: { name: string; startedAt: number } | undefined;
const telemetry = createTelemetryClient({
  surface: 'cli',
  workspaceRoot: () => resolveRepoRoot(process.cwd(), process.env),
});
program.name('concord').description('Shared work-state for coding agents').version(VERSION);

program.hook('preAction', (_command, actionCommand) => {
  activeCommand = { name: actionCommand.name(), startedAt: performance.now() };
});

program.hook('postAction', (_command, actionCommand) => {
  if (activeCommand?.name === actionCommand.name()) {
    telemetry?.recordOperation(
      activeCommand.name,
      'success',
      performance.now() - activeCommand.startedAt,
    );
    activeCommand = undefined;
  }
});

registerInit(program);
registerInstallCommand(program);
registerStatus(program);
registerWhoCommand(program);
registerTasks(program);
registerCheckCommand(program);
registerDashboardCommand(program);
registerWatchCommand(program);
registerHookCommand(program);
registerHandoffCommand(program);
registerReviewPacketCommand(program);
registerExportCommand(program);
registerDoctorCommand(program);

try {
  await notifyIfUpdateAvailable(VERSION);
  await program.parseAsync();
} catch (error) {
  if (activeCommand !== undefined) {
    telemetry?.recordOperation(
      activeCommand.name,
      'error',
      performance.now() - activeCommand.startedAt,
    );
  }
  throw error;
} finally {
  await telemetry?.close();
}
