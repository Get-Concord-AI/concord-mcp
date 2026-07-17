#!/usr/bin/env node
import { Command } from '@commander-js/extra-typings';

import { VERSION } from '../version.js';
import { registerInit } from './commands/init.js';
import { registerStatus } from './commands/status.js';
import { registerTasks } from './commands/tasks.js';

const program = new Command();
program.name('concord').description('Shared work-state for coding agents').version(VERSION);

registerInit(program);
registerStatus(program);
registerTasks(program);

program.parse();
