#!/usr/bin/env node
import { linkedMachine } from '../cloud/target.js';

/**
 * Pick the first positional argument, skipping the global options that take a
 * value. This keeps `concord cloud login` on the Cloud-only module graph even
 * before this machine has been linked.
 */
function firstCommand(args: readonly string[]): string | undefined {
  const valueOptions = new Set(['-C', '--repo', '--workspace']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (valueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith('--repo=') || argument.startsWith('--workspace=')) continue;
    if (argument.startsWith('-')) continue;
    return argument;
  }
  return undefined;
}

const cloudCommand = firstCommand(process.argv.slice(2)) === 'cloud';
if (linkedMachine(process.env) !== undefined || cloudCommand) {
  await import('./cloud-index.js');
} else {
  await import('./local-index.js');
}
