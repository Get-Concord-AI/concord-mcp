import { performance } from 'node:perf_hooks';

import { Command } from '@commander-js/extra-typings';

import { linkedMachine } from '../cloud/target.js';
import { resolveRepoRoot } from '../config/paths.js';
import { createTelemetryClient } from '../telemetry/client.js';
import { VERSION } from '../version.js';
import { notifyIfUpdateAvailable } from '../update-notifier.js';
import { configureCliWorkspace, parseCliWorkspaceOptions } from './workspace-options.js';

const program = new Command();
let workspaceRoot = resolveRepoRoot(process.cwd(), process.env);
let activeCommand: { name: string; startedAt: number } | undefined;
const backgroundCommands = new Set(['drain', 'watch', 'hook']);
/** Top-level commands a linked repository answers from Concord Cloud: not local, so not recorded. */
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
  const options = parseCliWorkspaceOptions(command.opts());
  const selected = configureCliWorkspace(options, process.cwd(), process.env);
  if (selected !== undefined) {
    workspaceRoot = selected.repoRoot;
    process.stderr.write(`Concord workspace: ${selected.workspaceId} (${selected.repoRoot})\n`);
  }
  // `concord cloud …` acts on Concord Cloud, which records its own usage; the
  // open-source CLI emits no telemetry, success or error, for non-local
  // operations. Checked by parent, since `cloud status` shares its name with
  // the local `status`. On a linked machine the inbox is the cloud's too.
  const parent = actionCommand.parent?.name();
  const nonLocal =
    parent === 'cloud' ||
    ((parent === 'inbox' || CLOUD_SERVED.has(actionCommand.name())) &&
      linkedMachine(process.env) !== undefined);
  activeCommand =
    nonLocal || parent === 'work'
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

type RegisterCommand = (target: Command) => void;

/**
 * Every top-level command, in help order, with the module that defines it.
 *
 * Loaded on demand: agent hooks run this CLI on every tool call, and importing
 * every command up front (the Ink dashboard, the MCP SDK) cost seconds per
 * call. A run defines only the command it was asked for; help, a bare
 * `concord`, and an unknown command still define them all.
 */
const COMMANDS: ReadonlyMap<string, () => Promise<RegisterCommand>> = new Map<
  string,
  () => Promise<RegisterCommand>
>([
  ['setup', async () => (await import('./commands/setup.js')).registerSetupCommand],
  ['adapters', async () => (await import('./commands/adapters.js')).registerAdaptersCommand],
  ['status', async () => (await import('./commands/status.js')).registerStatus],
  ['who', async () => (await import('./commands/who.js')).registerWhoCommand],
  ['messages', async () => (await import('./commands/messages.js')).registerMessagesCommand],
  ['tasks', async () => (await import('./commands/tasks.js')).registerTasks],
  ['check', async () => (await import('./commands/check.js')).registerCheckCommand],
  ['dashboard', async () => (await import('./commands/dashboard.js')).registerDashboardCommand],
  ['watch', async () => (await import('./commands/watch.js')).registerWatchCommand],
  [
    'hook',
    async () => {
      const { registerHookCommand } = await import('./commands/hook.js');
      return (target) => {
        registerHookCommand(target, telemetry);
      };
    },
  ],
  [
    'inbox',
    async () => {
      const { registerInboxCommand } = await import('./commands/inbox.js');
      return (target) => {
        registerInboxCommand(target, telemetry);
      };
    },
  ],
  ['handoff', async () => (await import('./commands/handoff.js')).registerHandoffCommand],
  [
    'work',
    async () => {
      const { registerWorkCommand } = await import('./commands/work.js');
      return (target) => {
        registerWorkCommand(target, telemetry);
      };
    },
  ],
  [
    'review-packet',
    async () => (await import('./commands/review-packet.js')).registerReviewPacketCommand,
  ],
  ['export', async () => (await import('./commands/export.js')).registerExportCommand],
  ['doctor', async () => (await import('./commands/doctor.js')).registerDoctorCommand],
  ['cloud', async () => (await import('./commands/cloud.js')).registerCloudCommand],
]);

const registeredCommands = new Set<string>();

/** Define the command `args` asks for, or every command when it names none we know. */
async function registerCommands(args: readonly string[]): Promise<void> {
  const requested = topLevelCommand(args);
  const only = requested !== undefined && COMMANDS.has(requested) ? requested : undefined;
  const pending = [...COMMANDS].filter(
    ([name]) => (only === undefined || name === only) && !registeredCommands.has(name),
  );
  const loaded = await Promise.all(
    pending.map(async ([name, load]) => ({ name, register: await load() })),
  );
  for (const { name, register } of loaded) {
    register(program);
    registeredCommands.add(name);
  }
}

/** Global options that take a value and therefore hide the following token. */
const GLOBAL_VALUE_FLAGS = new Set(['-C', '--repo', '--workspace']);

/** Help flags. Placed before the command they ask for the root help, which lists every command. */
const HELP_FLAGS = new Set(['-h', '--help']);

/**
 * The first positional token, past global options placed before the command.
 * A help flag before any command means root help, so it reports no command.
 */
export function topLevelCommand(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (HELP_FLAGS.has(token)) return undefined;
    if (token === '--') return argv[index + 1];
    if (GLOBAL_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

/**
 * Run the CLI. Pass `argv` as the user arguments (no `node` or script path);
 * the default reads `process.argv`.
 */
export async function runCli(argv?: readonly string[]): Promise<void> {
  const args = argv === undefined ? process.argv.slice(2) : [...argv];
  try {
    await notifyIfUpdateAvailable(VERSION);
    await registerCommands(args);
    if (argv === undefined) await program.parseAsync();
    else await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    if (activeCommand !== undefined && !backgroundCommands.has(activeCommand.name)) {
      telemetry?.recordOperation(
        activeCommand.name,
        'error',
        performance.now() - activeCommand.startedAt,
      );
    }
    // Global options are validated before the work action, so a bad `--workspace`
    // never reaches that command's own error writer.
    if (topLevelCommand(args) === 'work') {
      const { reportWorkFailure } = await import('./commands/work.js');
      reportWorkFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    throw error;
  } finally {
    await telemetry?.close();
  }
}
