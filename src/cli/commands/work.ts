import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isatty } from 'node:tty';

import { InvalidArgumentError, type Command } from '@commander-js/extra-typings';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { writeArtifacts } from '../../artifacts/index.js';
import { LINKED_MACHINE_MESSAGE, linkedMachine } from '../../cloud/target.js';
import { resolveRepoRoot } from '../../config/paths.js';
import { openRepositories, type Repositories } from '../../db/index.js';
import { resolveIdentity, type AgentIdentity } from '../../domain/identity.js';
import {
  finishWorkInputShape,
  transferWorkInputShape,
  updateWorkInputShape,
} from '../../domain/schemas.js';
import { createServer } from '../../server.js';
import type { TelemetryRecorder } from '../../telemetry/events.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { findAvailableUpdate, type AvailableUpdate } from '../../update-notifier.js';
import { VERSION } from '../../version.js';
import { WorkspaceManager } from '../../workspaces/manager.js';

export const WORK_ACTIONS = ['start', 'inspect', 'update', 'transfer', 'finish'] as const;
export type WorkAction = (typeof WORK_ACTIONS)[number];

const ACTION_DESCRIPTIONS: Readonly<Record<WorkAction, string>> = {
  start: 'Claim a task and register this agent (start_work); reports overlapping claims',
  inspect: 'Read the workspace, a task, an agent, or a message thread (inspect_work)',
  update: 'Record progress or a decision on a task, or message another agent (update_work)',
  transfer: 'Assign, accept, decline, release, reassign, offer, or reopen a task (transfer_work)',
  finish: 'Record evidence and hand off, mark review-ready, complete, or close (finish_work)',
};

const WORK_HELP = `
Each action calls the MCP tool of the same name in-process: start runs
start_work. --json passes the tool's arguments as a JSON object, and a flag
sets one field over it. Prints the tool's structured result as JSON; on a
failure it prints {"error": "..."} instead, writes the message to stderr, and
exits 1.`;

const workFlagsSchema = z.object({
  agent: z.string().optional(),
  kind: z.string().optional(),
  task: z.string().optional(),
  title: z.string().optional(),
  files: z.array(z.string()).optional(),
  type: z.string().optional(),
  content: z.string().optional(),
  action: z.string().optional(),
  to: z.string().optional(),
  expectedVersion: z.number().optional(),
  outcome: z.string().optional(),
  summary: z.string().optional(),
  message: z.string().optional(),
});
export type WorkFlags = z.infer<typeof workFlagsSchema>;
const commandOptionsSchema = workFlagsSchema.extend({ json: z.string().optional() });

type FlagName = Exclude<keyof WorkFlags, 'agent' | 'kind'>;

interface FlagSpec {
  readonly usage: string;
  /** The tool argument the flag sets, replacing that field of the JSON input. */
  readonly field: string;
  readonly help: string;
  readonly value?: 'list' | 'integer';
}

const FLAGS: Readonly<Record<FlagName, FlagSpec>> = {
  task: { usage: '--task <id>', field: 'task_id', help: 'Task id' },
  title: { usage: '--title <title>', field: 'title', help: 'Task title' },
  files: {
    usage: '--files <paths>',
    field: 'expected_files',
    help: 'Files you expect to edit, comma-separated; repeatable',
    value: 'list',
  },
  type: {
    usage: '--type <kind>',
    field: 'kind',
    help: `Update kind: ${updateWorkInputShape.kind.unwrap().options.join(', ')}`,
  },
  content: { usage: '--content <text>', field: 'content', help: 'Update text' },
  action: {
    usage: '--action <action>',
    field: 'action',
    help: `One of: ${transferWorkInputShape.action.options.join(', ')}`,
  },
  to: { usage: '--to <agent>', field: 'to_agent_id', help: 'Agent the task goes to' },
  expectedVersion: {
    usage: '--expected-version <n>',
    field: 'expected_version',
    help: 'Task version you last read',
    value: 'integer',
  },
  outcome: {
    usage: '--outcome <outcome>',
    field: 'outcome',
    help: `One of: ${finishWorkInputShape.outcome.unwrap().options.join(', ')}`,
  },
  summary: { usage: '--summary <text>', field: 'what_changed', help: 'What changed' },
  message: { usage: '--message <id>', field: 'message_id', help: 'Message thread to read' },
};

const ACTION_FLAGS: Readonly<Record<WorkAction, readonly FlagName[]>> = {
  start: ['task', 'title', 'files'],
  inspect: ['task', 'message'],
  update: ['task', 'type', 'content'],
  transfer: ['task', 'action', 'to', 'expectedVersion'],
  finish: ['task', 'expectedVersion', 'outcome', 'summary'],
};

const jsonObjectSchema = z.record(z.string(), z.json());
type JsonObject = z.infer<typeof jsonObjectSchema>;

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: jsonObjectSchema.optional(),
  content: z.array(z.object({ text: z.string().optional() })).default([]),
});

export const NO_STDIN_MESSAGE = 'No input on stdin; pipe JSON or pass --json <file>.';
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export interface WorkInput {
  /** Path of a JSON arguments file, or `-` to read stdin. */
  readonly jsonPath?: string;
  readonly flags?: WorkFlags;
}

export interface RunWorkOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: { readonly isTTY: () => boolean; readonly read: () => Uint8Array };
}

export type WorkRunResult =
  | { readonly exitCode: 0; readonly output: string }
  | { readonly exitCode: 1; readonly output: string; readonly error: string };

function failure(message: string): WorkRunResult {
  return { exitCode: 1, output: `${JSON.stringify({ error: message })}\n`, error: message };
}

/**
 * The daily cache `findAvailableUpdate` already shares with the CLI. A miss may
 * do that function's short registry read; a failure never fails this command.
 */
async function availableUpdate(env: NodeJS.ProcessEnv): Promise<AvailableUpdate | undefined> {
  try {
    return await findAvailableUpdate(VERSION, env);
  } catch {
    return undefined;
  }
}

/** Decodes UTF-8, dropping a byte-order mark as Windows editors and PowerShell write one. */
function decodeInput(bytes: Uint8Array): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new Error('The input is UTF-16; save it as UTF-8.');
  }
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    throw new Error('The input is not valid UTF-8; save it as UTF-8.', { cause: error });
  }
}

function readArguments(jsonPath: string, options: RunWorkOptions): JsonObject {
  const fromStdin = jsonPath === '-';
  if (fromStdin && options.stdin.isTTY()) throw new Error(NO_STDIN_MESSAGE);
  const bytes = fromStdin ? options.stdin.read() : readFileSync(resolve(options.cwd, jsonPath));
  const text = decodeInput(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const source = fromStdin ? 'on stdin' : `in ${jsonPath}`;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON ${source}: ${reason}`, { cause: error });
  }
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) throw new Error('The JSON input must be an object of tool arguments.');
  return parsed.data;
}

function agentKind(flags: WorkFlags, env: NodeJS.ProcessEnv): string | undefined {
  const kind = (flags.kind ?? env['CONCORD_AGENT_KIND'])?.trim();
  return kind === '' ? undefined : kind;
}

/** `--agent` names this caller the way CONCORD_AGENT_ID does for the MCP server. */
function workIdentity(
  flags: WorkFlags,
  kind: string | undefined,
  env: NodeJS.ProcessEnv,
): AgentIdentity | undefined {
  const source = flags.agent === undefined ? env : { ...env, CONCORD_AGENT_ID: flags.agent };
  return resolveIdentity(source, kind === undefined ? {} : { kind });
}

function toolArguments(
  action: WorkAction,
  json: JsonObject,
  flags: WorkFlags,
  kind: string | undefined,
): JsonObject {
  const args: JsonObject = { ...json };
  for (const name of ACTION_FLAGS[action]) {
    const value = flags[name];
    if (value !== undefined) args[FLAGS[name].field] = value;
  }
  if (action === 'start' && args['kind'] === undefined && kind !== undefined) args['kind'] = kind;
  return args;
}

function toolOutput(result: z.infer<typeof toolResultSchema>): WorkRunResult {
  const text = result.content.flatMap((block) => (block.text === undefined ? [] : [block.text]));
  const message = text.join('\n').trim();
  if (result.isError === true) {
    return failure(message === '' ? 'The tool failed without a message.' : message);
  }
  if (result.structuredContent === undefined) {
    return failure('The tool returned no structured result.');
  }
  return { exitCode: 0, output: `${JSON.stringify(result.structuredContent, null, 2)}\n` };
}

/**
 * Run one workflow tool through the same MCP server `concord-mcp` serves, over
 * an in-process transport, so validation, identity and results match.
 */
export async function runWork(
  action: WorkAction,
  input: WorkInput,
  options: RunWorkOptions,
): Promise<WorkRunResult> {
  const opened: Repositories[] = [];
  let client: Client | undefined;
  let server: McpServer | undefined;
  try {
    if (linkedMachine(options.env) !== undefined) return failure(LINKED_MACHINE_MESSAGE);
    const updatePromise = availableUpdate(options.env);
    const json = input.jsonPath === undefined ? {} : readArguments(input.jsonPath, options);
    const repoRoot = resolveRepoRoot(options.cwd, options.env);
    const flags = input.flags ?? {};
    const kind = agentKind(flags, options.env);
    const identity = workIdentity(flags, kind, options.env);
    const workspaceManager = WorkspaceManager.fromEnvironment(repoRoot, options.env, {
      open: (databasePath, project) => {
        const repos = openRepositories(databasePath, project);
        opened.push(repos);
        return repos;
      },
    });
    if (identity !== undefined) {
      ensureAgentRegistered(workspaceManager.current().repos, identity, repoRoot);
    }
    const update = await updatePromise;
    server = createServer(workspaceManager.current().repos, {
      workspaceManager,
      ...(identity === undefined ? {} : { identity }),
      getAvailableUpdate: () => update,
      onToolWrite: (workspace) => {
        if (workspace !== undefined) writeArtifacts(workspace.concordPath, workspace.repos);
      },
    });
    client = new Client({ name: 'concord-cli', version: VERSION });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const raw = await client.callTool({
      name: `${action}_work`,
      arguments: toolArguments(action, json, flags, kind),
    });
    // The in-memory transport hands objects over unserialized; a stdio client
    // would only ever see the JSON form.
    const result = toolResultSchema.safeParse(JSON.parse(JSON.stringify(raw)));
    if (!result.success) return failure('The tool returned a result this command cannot read.');
    return toolOutput(result.data);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  } finally {
    await Promise.allSettled([client?.close(), server?.close()]);
    for (const repos of opened) repos.db.close();
  }
}

function collectList(value: string, previous: string[] | undefined): string[] {
  const items = value.split(',').map((item) => item.trim());
  return [...(previous ?? []), ...items.filter((item) => item !== '')];
}

function parseVersion(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new InvalidArgumentError('Expected a positive integer.');
  return Number(value);
}

function addFlag(command: Command, flag: FlagSpec): void {
  const help = `${flag.help} (JSON: ${flag.field})`;
  if (flag.value === 'list') command.option(flag.usage, help, collectList);
  else if (flag.value === 'integer') command.option(flag.usage, help, parseVersion);
  else command.option(flag.usage, help);
}

const STDIN = { isTTY: () => isatty(0), read: () => readFileSync(0) };

/** One usage event. A throw here must not change what the command prints or its exit code. */
function recordWorkCall(
  telemetry: TelemetryRecorder | undefined,
  action: WorkAction,
  exitCode: 0 | 1,
  durationMs: number,
): void {
  try {
    telemetry?.recordOperation(`work ${action}`, exitCode === 0 ? 'success' : 'error', durationMs);
  } catch {
    // Usage data is best-effort, same as the telemetry client itself.
  }
}

export function registerWorkCommand(program: Command, telemetry?: TelemetryRecorder): void {
  const work = program
    .command('work')
    .description('Run a Concord workflow tool from the shell and print its result as JSON')
    .addHelpText('after', WORK_HELP)
    .configureOutput({
      outputError: (message, write) => {
        write(message);
        const error = message.replace(/^error: /u, '').trim();
        process.stdout.write(`${JSON.stringify({ error })}\n`);
      },
    });
  for (const action of WORK_ACTIONS) {
    const command = work
      .command(action)
      .description(ACTION_DESCRIPTIONS[action])
      .option('--json <file|->', 'Tool arguments as a JSON object in a UTF-8 file, or - for stdin')
      .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the current session')
      .option('--kind <kind>', 'Agent kind; defaults to CONCORD_AGENT_KIND');
    for (const name of ACTION_FLAGS[action]) addFlag(command, FLAGS[name]);
    command.action(async (options) => {
      const startedAt = performance.now();
      const { json, ...flags } = commandOptionsSchema.parse(options);
      const result = await runWork(
        action,
        { ...(json === undefined ? {} : { jsonPath: json }), flags },
        { env: process.env, cwd: process.cwd(), stdin: STDIN },
      );
      process.stdout.write(result.output);
      if (result.exitCode === 1) {
        process.stderr.write(`${result.error}\n`);
        process.exitCode = 1;
      }
      recordWorkCall(telemetry, action, result.exitCode, performance.now() - startedAt);
    });
  }
}
