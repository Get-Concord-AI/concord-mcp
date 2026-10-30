import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { writeFakeCommand } from './fake-command.js';

/**
 * A fake `opencode` CLI. It appends each invocation's arguments to the file in
 * `FAKE_OC_LOG`, prints `FAKE_OC_VERSION` for `--version`, answers
 * `api GET /api/mcp` with the file in `FAKE_OC_MCP`, and exits 1 for every
 * other command when `FAKE_OC_FAIL` is set.
 */
const SCRIPT = `
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_OC_LOG) appendFileSync(process.env.FAKE_OC_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log(process.env.FAKE_OC_VERSION ?? '2.2.3'); process.exit(0); }
if (process.env.FAKE_OC_FAIL) { console.error('boom'); process.exit(1); }
if (args[0] === 'api' && args[2] === '/api/mcp') {
  console.log(process.env.FAKE_OC_MCP ? readFileSync(process.env.FAKE_OC_MCP, 'utf8') : '{"data":[]}');
}
`;

export function writeFakeOpencode(directory: string): string {
  return writeFakeCommand(directory, 'opencode', SCRIPT);
}

/** Every invocation the fake recorded, as argument lists. */
export function recordedInvocations(logPath: string): string[][] {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => z.array(z.string()).parse(JSON.parse(line)));
}
