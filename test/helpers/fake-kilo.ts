import { writeFakeCommand } from './fake-command.js';

/**
 * A fake `kilo` CLI. It appends each invocation's arguments to the file in
 * `FAKE_KILO_LOG`, prints `FAKE_KILO_VERSION` (default 7.8.27) for
 * `--version`, answers `mcp --help` and every other `mcp` invocation with
 * success unless `FAKE_KILO_NO_MCP` is set, prints `mcp add --help` usage
 * listing `--env` unless `FAKE_KILO_NO_ADD_ENV` is set, and exits 1 for
 * every other command when `FAKE_KILO_FAIL` is set.
 */
const SCRIPT = `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_KILO_LOG) appendFileSync(process.env.FAKE_KILO_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log(process.env.FAKE_KILO_VERSION ?? '7.8.27'); process.exit(0); }
if (process.env.FAKE_KILO_NO_MCP && args[0] === 'mcp') { console.error("error: unknown command 'mcp'"); process.exit(1); }
if (args[0] === 'mcp' && args[1] === 'add' && args[2] === '--help') {
  if (process.env.FAKE_KILO_NO_ADD_ENV) { console.log('Usage: kilo mcp add <name> [--scope] -- <command>'); }
  else { console.log('Usage: kilo mcp add <name> [--env K=V]... -- <command>'); }
  process.exit(0);
}
if (args[0] === 'mcp') { console.log('kilo mcp'); process.exit(0); }
if (process.env.FAKE_KILO_FAIL) { console.error('boom'); process.exit(1); }
`;

export function writeFakeKilo(directory: string): string {
  return writeFakeCommand(directory, 'kilo', SCRIPT);
}
