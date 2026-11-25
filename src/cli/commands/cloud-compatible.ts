import type { Command } from '@commander-js/extra-typings';

import { registerCheckCommand } from './check.js';
import { registerDoctorCommand } from './doctor.js';
import { registerMessagesCommand } from './messages.js';
import { registerSetupCommand } from './setup.js';
import { registerLinkedWorkCommand } from './work-linked.js';

/** Commands whose linked-machine paths work without opening Concord's local store. */
export function registerCloudCompatibleCommands(program: Command): void {
  registerCheckCommand(program);
  registerDoctorCommand(program);
  registerMessagesCommand(program);
  registerSetupCommand(program);
  registerLinkedWorkCommand(program);
}
