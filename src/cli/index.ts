#!/usr/bin/env node
import { Command } from '@commander-js/extra-typings';

import { VERSION } from '../version.js';
import { registerCheckCommand } from './commands/check.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerExportCommand } from './commands/export.js';
import { registerHandoffCommand } from './commands/handoff.js';
import { registerInit } from './commands/init.js';
import { registerInstallCommand } from './commands/install.js';
import { registerReviewPacketCommand } from './commands/review-packet.js';
import { registerStatus } from './commands/status.js';
import { registerTasks } from './commands/tasks.js';

const program = new Command();
program.name('concord').description('Shared work-state for coding agents').version(VERSION);

registerInit(program);
registerInstallCommand(program);
registerStatus(program);
registerTasks(program);
registerCheckCommand(program);
registerHandoffCommand(program);
registerReviewPacketCommand(program);
registerExportCommand(program);
registerDoctorCommand(program);

program.parse();
