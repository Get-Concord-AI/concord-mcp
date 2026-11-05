import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CONCORD_SERVER_ONLY } from '../../src/cli/commands/session-start-message.js';
import {
  NO_STDIN_MESSAGE,
  registerWorkCommand,
  runWork,
  type RunWorkOptions,
  type WorkAction,
  type WorkInput,
  type WorkRunResult,
} from '../../src/cli/commands/work.js';
import { ensureMachineKey, writeCredentials } from '../../src/cloud/settings.js';
import { LINKED_MACHINE_MESSAGE } from '../../src/cloud/target.js';
import { openRepositories, type Repositories } from '../../src/db/index.js';
import { UNRESOLVED_IDENTITY_MESSAGE } from '../../src/domain/identity.js';
import {
  CONCORD_GLOBAL_INSTRUCTIONS,
  CONCORD_INSTRUCTIONS,
  CONCORD_SERVER_INSTRUCTIONS,
} from '../../src/install/instructions.js';
import { createServer } from '../../src/server.js';
import type { TelemetryRecorder } from '../../src/telemetry/events.js';
import { VERSION } from '../../src/version.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';

const taskSchema = z.object({ task_id: z.string(), status: z.string(), version: z.number() });
const noticeSchema = z.object({
  scope: z.literal('workspace'),
  update_available: z
    .object({
      current_version: z.string(),
      latest_version: z.string(),
      command: z.string(),
    })
    .optional(),
});
const agentSchema = z.object({ agent_id: z.string() });
const errorSchema = z.object({ error: z.string() });
const workStateSchema = z.object({
  tasks: z.array(
    z.object({
      task_id: z.string(),
      title: z.string(),
      status: z.string(),
      expected_files: z.array(z.string()),
    }),
  ),
});

function parsed<T>(result: WorkRunResult, schema: z.ZodType<T>): T {
  if (result.exitCode !== 0) throw new Error(`Expected success, got ${result.output}`);
  return schema.parse(JSON.parse(result.output));
}

function noStdin(): never {
  throw new Error('This test reads no stdin.');
}

function pipedStdin(bytes: Uint8Array): RunWorkOptions['stdin'] {
  return { isTTY: () => false, read: () => bytes };
}

function failed(result: WorkRunResult): string {
  if (result.exitCode !== 1) throw new Error(`Expected a failure, got ${result.output}`);
  expect(errorSchema.parse(JSON.parse(result.output))).toEqual({ error: result.error });
  return result.error;
}

function cli(telemetry?: TelemetryRecorder): Command {
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerWorkCommand(program, telemetry);
  return program;
}

function workCommand(program: Command, action: string): CommandUnknownOpts {
  const work = program.commands.find((command) => command.name() === 'work');
  const command = work?.commands.find((entry) => entry.name() === action);
  if (command === undefined) throw new Error(`Expected a work ${action} command`);
  return command;
}

function captureOutput(): { stdout: () => string; stderr: () => string } {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return {
    stdout: () => stdout.mock.calls.map((call) => String(call[0])).join(''),
    stderr: () => stderr.mock.calls.map((call) => String(call[0])).join(''),
  };
}

describe('concord work', () => {
  let temporary: string[] = [];
  let repo: string;
  let env: NodeJS.ProcessEnv;

  function tempDir(label: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `concord-work-${label}-`)));
    temporary.push(dir);
    return dir;
  }

  function run(
    action: WorkAction,
    input: WorkInput,
    extraEnv: NodeJS.ProcessEnv = {},
    checkUpdates = false,
  ): Promise<WorkRunResult> {
    const merged: NodeJS.ProcessEnv = { ...env, ...extraEnv };
    if (checkUpdates) delete merged['CONCORD_NO_UPDATE_CHECK'];
    const stdin = { isTTY: () => false, read: noStdin };
    return runWork(action, input, { env: merged, cwd: repo, stdin });
  }

  function writeInput(name: string, content: string | Uint8Array): string {
    const path = join(repo, name);
    writeFileSync(path, content);
    return path;
  }

  function seedUpdateCache(latestVersion: string): void {
    const cacheHome = env['XDG_CACHE_HOME'];
    if (cacheHome === undefined) throw new Error('Expected a temp cache home');
    const dir = join(cacheHome, 'concord');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'update-check.json'),
      `${JSON.stringify({ checkedAt: Date.now(), latestVersion })}\n`,
    );
  }

  beforeEach(() => {
    repo = tempDir('repo');
    mkdirSync(join(repo, '.git'));
    const home = tempDir('home');
    env = {
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: join(home, '.cache'),
      CONCORD_NO_UPDATE_CHECK: '1',
    };
    vi.stubGlobal('fetch', (): Promise<never> =>
      Promise.reject(new Error('concord work tests do not use the network')),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const dir of temporary) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    temporary = [];
  });

  it('runs start, inspect, update, and finish against the store and writes artifacts', async () => {
    writeInput(
      'start.json',
      JSON.stringify({ task_id: 'cli-1', title: 'From JSON', expected_files: ['old.ts'] }),
    );
    const started = parsed(
      await run('start', {
        jsonPath: 'start.json',
        flags: { agent: 'alpha:1', kind: 'cursor', title: 'Round trip', files: ['work.ts'] },
      }),
      taskSchema,
    );
    expect(started).toEqual({ task_id: 'cli-1', status: 'active', version: 1 });

    const inspected = parsed(
      await run('inspect', { flags: { agent: 'alpha:1', task: 'cli-1' } }),
      z.object({ task: z.object({ taskId: z.string(), status: z.string(), version: z.number() }) }),
    );
    expect(inspected.task).toEqual({ taskId: 'cli-1', status: 'active', version: 1 });

    const updated = parsed(
      await run('update', {
        flags: { agent: 'alpha:1', task: 'cli-1', type: 'progress', content: 'Halfway' },
      }),
      z.object({ task_id: z.string(), kind: z.string() }),
    );
    expect(updated).toEqual({ task_id: 'cli-1', kind: 'progress' });

    const finished = parsed(
      await run('finish', {
        flags: {
          agent: 'alpha:1',
          task: 'cli-1',
          outcome: 'complete',
          summary: 'Added concord work',
          expectedVersion: inspected.task.version,
        },
      }),
      taskSchema,
    );
    expect(finished).toMatchObject({ task_id: 'cli-1', status: 'complete' });

    const state = workStateSchema.parse(
      JSON.parse(readFileSync(join(repo, '.concord', 'WORK_STATE.json'), 'utf8')),
    );
    expect(state.tasks).toEqual([
      { task_id: 'cli-1', title: 'Round trip', status: 'complete', expected_files: ['work.ts'] },
    ]);
    expect(readFileSync(join(repo, '.concord', 'HANDOFF.md'), 'utf8')).toContain(
      'Added concord work',
    );
  });

  it('shares one store with an MCP server held open on the same repository', async () => {
    const opened: Repositories[] = [];
    const manager = WorkspaceManager.fromEnvironment(repo, env, {
      open: (databasePath, project) => {
        const repos = openRepositories(databasePath, project);
        opened.push(repos);
        return repos;
      },
    });
    const server = createServer(manager.current().repos, {
      workspaceManager: manager,
      identity: { agentId: 'mcp:1', kind: 'cursor', origin: 'operator' },
    });
    const client = new Client({ name: 'work-test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const viaMcp = z.object({ structuredContent: taskSchema }).parse(
        await client.callTool({
          name: 'start_work',
          arguments: { task_id: 'mixed', title: 'Both doors', kind: 'cursor' },
        }),
      ).structuredContent;

      const viaCli = parsed(
        await run('inspect', { flags: { agent: 'mcp:1', task: 'mixed' } }),
        z.object({ task: z.object({ taskId: z.string(), version: z.number() }) }),
      );
      expect(viaCli.task).toMatchObject({ taskId: 'mixed', version: viaMcp.version });

      const finished = parsed(
        await run('finish', {
          flags: {
            agent: 'mcp:1',
            task: 'mixed',
            summary: 'Finished from the shell',
            expectedVersion: viaMcp.version,
          },
        }),
        taskSchema,
      );
      expect(finished.status).toBe('complete');

      const stale = await client.callTool({
        name: 'finish_work',
        arguments: {
          task_id: 'mixed',
          what_changed: 'Too late',
          expected_version: viaMcp.version,
        },
      });
      expect(stale.isError).toBe(true);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      for (const repos of opened) repos.db.close();
    }
  });

  it('acts as --agent over an agent_id in the JSON and registers only that agent', async () => {
    const jsonPath = writeInput(
      'who.json',
      JSON.stringify({ task_id: 'who', title: 'Identity', kind: 'cursor', agent_id: 'json:9' }),
    );
    const started = parsed(
      await run('start', { jsonPath, flags: { agent: 'alpha:1' } }),
      agentSchema,
    );
    expect(started.agent_id).toBe('alpha:1');

    const workspace = parsed(
      await run('inspect', { flags: { agent: 'alpha:1' } }),
      z.object({ presence: z.array(z.object({ agentId: z.string() })) }),
    );
    expect(workspace.presence.map((entry) => entry.agentId)).toEqual(['alpha:1']);
  });

  it('takes the agent from CONCORD_AGENT_ID and start kind from CONCORD_AGENT_KIND', async () => {
    const started = parsed(
      await run(
        'start',
        { flags: { task: 'env', title: 'From the environment' } },
        { CONCORD_AGENT_ID: 'env:1', CONCORD_AGENT_KIND: 'codex' },
      ),
      agentSchema,
    );
    expect(started.agent_id).toBe('env:1');
  });

  it('fails with the unresolved-identity message when no agent is named', async () => {
    const error = failed(
      await run('start', { flags: { kind: 'cursor', task: 'nobody', title: 'Nobody' } }),
    );
    expect(error).toContain(UNRESOLVED_IDENTITY_MESSAGE);
  });

  it('reports an overlapping claim on the same file', async () => {
    parsed(
      await run('start', {
        flags: {
          agent: 'alpha:1',
          kind: 'cursor',
          task: 'one',
          title: 'One',
          files: ['shared.ts'],
        },
      }),
      taskSchema,
    );
    const second = parsed(
      await run('start', {
        flags: { agent: 'beta:1', kind: 'cursor', task: 'two', title: 'Two', files: ['shared.ts'] },
      }),
      z.object({
        overlaps: z.array(z.object({ task_id: z.string(), reasons: z.array(z.string()) })),
      }),
    );
    expect(second.overlaps.map((overlap) => overlap.task_id)).toEqual(['one']);
    expect(second.overlaps[0]?.reasons.join(' ')).toContain('shared.ts');
  });

  it('reads JSON from stdin and from a UTF-8 file with a byte-order mark', async () => {
    const stdin = Buffer.from(JSON.stringify({ task_id: 'piped', title: 'Stdin', kind: 'cursor' }));
    const piped = parsed(
      await runWork(
        'start',
        { jsonPath: '-', flags: { agent: 'alpha:1' } },
        { env, cwd: repo, stdin: pipedStdin(stdin) },
      ),
      taskSchema,
    );
    expect(piped.task_id).toBe('piped');

    const bom = writeInput(
      'bom.json',
      `\uFEFF${JSON.stringify({ task_id: 'bom', title: 'BOM', kind: 'cursor' })}`,
    );
    const fromBom = parsed(
      await run('start', { jsonPath: bom, flags: { agent: 'alpha:1' } }),
      taskSchema,
    );
    expect(fromBom.task_id).toBe('bom');
  });

  it('rejects UTF-16 and other non-UTF-8 input with a clear error', async () => {
    const text = JSON.stringify({ task_id: 'wide', title: 'Wide', kind: 'cursor' });
    const utf16 = writeInput(
      'utf16.json',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    );
    expect(failed(await run('start', { jsonPath: utf16, flags: { agent: 'alpha:1' } }))).toBe(
      'The input is UTF-16; save it as UTF-8.',
    );
    const ansi = writeInput('ansi.json', Buffer.from('{"title":"caf\u00e9"}', 'latin1'));
    expect(failed(await run('start', { jsonPath: ansi }))).toBe(
      'The input is not valid UTF-8; save it as UTF-8.',
    );
  });

  it('fails fast when --json - has a terminal on stdin instead of a pipe', async () => {
    const result = await runWork(
      'start',
      { jsonPath: '-', flags: { agent: 'alpha:1' } },
      { env, cwd: repo, stdin: { isTTY: () => true, read: noStdin } },
    );
    expect(failed(result)).toBe(NO_STDIN_MESSAGE);
    expect(existsSync(join(repo, '.concord'))).toBe(false);
  });

  it('names the file or stdin when the JSON input does not parse', async () => {
    const badFile = await run('start', { jsonPath: writeInput('bad.json', '{') });
    expect(failed(badFile)).toMatch(/^Invalid JSON in .*bad\.json: \S/u);
    const badStdin = await runWork(
      'start',
      { jsonPath: '-' },
      { env, cwd: repo, stdin: pipedStdin(Buffer.from('{"task_id":')) },
    );
    expect(failed(badStdin)).toMatch(/^Invalid JSON on stdin: \S/u);
  });

  it('exits 1 with an error object for non-object JSON and a stale version', async () => {
    for (const value of ['[1]', '"text"']) {
      expect(failed(await run('start', { jsonPath: writeInput('value.json', value) }))).toBe(
        'The JSON input must be an object of tool arguments.',
      );
    }

    parsed(
      await run('start', {
        flags: { agent: 'alpha:1', kind: 'cursor', task: 'old', title: 'Old' },
      }),
      taskSchema,
    );
    const stale = failed(
      await run('finish', {
        flags: { agent: 'alpha:1', task: 'old', summary: 'Too late', expectedVersion: 7 },
      }),
    );
    expect(stale).toContain('version conflict');
  });

  it('lets flags replace JSON fields, including --expected-version', async () => {
    const startPath = writeInput(
      'start.json',
      JSON.stringify({ task_id: 'from-json', title: 'Flag wins', kind: 'cursor' }),
    );
    const started = parsed(
      await run('start', { jsonPath: startPath, flags: { agent: 'alpha:1', task: 'from-flag' } }),
      taskSchema,
    );
    expect(started.task_id).toBe('from-flag');

    const finishPath = writeInput(
      'finish.json',
      JSON.stringify({ task_id: 'from-flag', what_changed: 'Done', expected_version: 99 }),
    );
    const finished = parsed(
      await run('finish', {
        jsonPath: finishPath,
        flags: { agent: 'alpha:1', expectedVersion: started.version },
      }),
      taskSchema,
    );
    expect(finished).toMatchObject({ task_id: 'from-flag', status: 'complete' });
  });

  it('refuses a Cloud-linked machine before opening a store', async () => {
    writeCredentials(env, { apiUrl: 'https://api.concord.test', apiKey: 'ck_test' });
    ensureMachineKey(env, () => 'machine-1');
    expect(failed(await run('inspect', {}))).toBe(LINKED_MACHINE_MESSAGE);
    expect(existsSync(join(repo, '.concord'))).toBe(false);
  });

  it('refuses a Cloud-linked machine before reading stdin', async () => {
    writeCredentials(env, { apiUrl: 'https://api.concord.test', apiKey: 'ck_test' });
    ensureMachineKey(env, () => 'machine-1');
    const read = vi.fn((): never => {
      throw new Error('stdin was read');
    });
    const result = await runWork(
      'inspect',
      { jsonPath: '-' },
      {
        env,
        cwd: repo,
        stdin: { isTTY: () => false, read },
      },
    );
    expect(failed(result)).toBe(LINKED_MACHINE_MESSAGE);
    expect(read).not.toHaveBeenCalled();
  });

  it('parses --files lists and --expected-version as a number', async () => {
    const startProgram = cli();
    const start = workCommand(startProgram, 'start');
    start.action(() => undefined);
    await startProgram.parseAsync(['work', 'start', '--files', 'a.ts, b.ts', '--files', 'c.ts'], {
      from: 'user',
    });
    expect(z.object({ files: z.array(z.string()) }).parse(start.opts())).toEqual({
      files: ['a.ts', 'b.ts', 'c.ts'],
    });

    const finishProgram = cli();
    const finish = workCommand(finishProgram, 'finish');
    finish.action(() => undefined);
    await finishProgram.parseAsync(['work', 'finish', '--expected-version', '3'], { from: 'user' });
    expect(z.object({ expectedVersion: z.number() }).parse(finish.opts())).toEqual({
      expectedVersion: 3,
    });
  });

  it('answers an unknown action, a foreign flag, or a bad number with a JSON error', async () => {
    const output = captureOutput();
    await expect(cli().parseAsync(['work', 'nope'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.unknownCommand',
      exitCode: 1,
    });
    await expect(
      cli().parseAsync(['work', 'inspect', '--title', 'x'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.unknownOption', exitCode: 1 });
    await expect(
      cli().parseAsync(['work', 'finish', '--expected-version', 'two'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.invalidArgument', exitCode: 1 });
    const errors = output
      .stdout()
      .trim()
      .split('\n')
      .map((line) => errorSchema.parse(JSON.parse(line)).error);
    expect(errors).toEqual([
      "unknown command 'nope'",
      "unknown option '--title'",
      "option '--expected-version <n>' argument 'two' is invalid. Expected a positive integer.",
    ]);
  });

  it('prints update_available when the daily cache has a newer release', async () => {
    seedUpdateCache('99.0.0');
    const result = await run('inspect', {}, {}, true);
    expect(parsed(result, noticeSchema).update_available).toEqual({
      current_version: VERSION,
      latest_version: '99.0.0',
      command: 'npm install -g @concord-ai/concord-mcp@latest',
    });
  });

  it('omits the update notice when CONCORD_NO_UPDATE_CHECK=1', async () => {
    seedUpdateCache('99.0.0');
    const result = await run('inspect', {}, { CONCORD_NO_UPDATE_CHECK: '1' });
    expect(result.output).not.toContain('update_available');
    expect(parsed(result, noticeSchema).update_available).toBeUndefined();
  });

  it('omits the update notice when CI is set', async () => {
    seedUpdateCache('99.0.0');
    const result = await run('inspect', {}, { CI: '1' }, true);
    expect(result.output).not.toContain('update_available');
    expect(parsed(result, noticeSchema).update_available).toBeUndefined();
  });

  it('omits the update notice when the cached release is not newer', async () => {
    seedUpdateCache(VERSION);
    const result = await run('inspect', {}, {}, true);
    expect(result.output).not.toContain('update_available');
    expect(parsed(result, noticeSchema).update_available).toBeUndefined();
  });

  it('a hanging update check does not fail the command', async () => {
    const result = await run('inspect', {}, {}, true);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('update_available');
    expect(parsed(result, noticeSchema).update_available).toBeUndefined();
  });

  it('records a work telemetry event for a success and a failure without the request text', async () => {
    const agent = 'agent-secret-id';
    const content = 'secret-progress-text';
    const recorded: { operation: string; outcome: string; durationMs: number }[] = [];
    const telemetry: TelemetryRecorder = {
      taskPseudonym: () => {
        throw new Error('task id must not be read');
      },
      recordEvent: () => {
        throw new Error('work calls do not emit a semantic event');
      },
      recordOperation: (operation, outcome, durationMs) => {
        recorded.push({ operation, outcome, durationMs });
      },
    };
    const savedCwd = process.cwd();
    const savedExit = process.exitCode;
    const output = captureOutput();
    const savedHome = process.env['HOME'];
    const savedProfile = process.env['USERPROFILE'];
    const savedCache = process.env['XDG_CACHE_HOME'];
    const savedUpdateCheck = process.env['CONCORD_NO_UPDATE_CHECK'];
    const savedRepo = process.env['CONCORD_REPO_ROOT'];
    const savedClaude = process.env['CLAUDE_PROJECT_DIR'];
    const savedDevin = process.env['DEVIN_PROJECT_DIR'];
    const savedAgent = process.env['CONCORD_AGENT_ID'];
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    };
    try {
      process.chdir(repo);
      process.env['HOME'] = env['HOME'];
      process.env['USERPROFILE'] = env['USERPROFILE'];
      process.env['XDG_CACHE_HOME'] = env['XDG_CACHE_HOME'];
      process.env['CONCORD_NO_UPDATE_CHECK'] = '1';
      delete process.env['CONCORD_REPO_ROOT'];
      delete process.env['CLAUDE_PROJECT_DIR'];
      delete process.env['DEVIN_PROJECT_DIR'];
      delete process.env['CONCORD_AGENT_ID'];

      const program = cli(telemetry);
      await program.parseAsync(
        [
          'work',
          'start',
          '--agent',
          agent,
          '--kind',
          'cursor',
          '--task',
          'tel-1',
          '--title',
          'Telemetry',
        ],
        { from: 'user' },
      );
      await program.parseAsync(
        [
          'work',
          'update',
          '--agent',
          agent,
          '--task',
          'tel-1',
          '--type',
          'progress',
          '--content',
          content,
        ],
        { from: 'user' },
      );
      process.exitCode = 0;
      await program.parseAsync(
        [
          'work',
          'update',
          '--agent',
          agent,
          '--task',
          'missing-task',
          '--type',
          'progress',
          '--content',
          content,
        ],
        { from: 'user' },
      );
      expect(process.exitCode).toBe(1);

      const payload = JSON.stringify(recorded);
      expect(payload).not.toContain(content);
      expect(payload).not.toContain(agent);
      expect(recorded.map((event) => [event.operation, event.outcome])).toEqual([
        ['work start', 'success'],
        ['work update', 'success'],
        ['work update', 'error'],
      ]);
      for (const event of recorded) expect(event.durationMs).toBeGreaterThanOrEqual(0);

      process.exitCode = 0;
      await cli({
        taskPseudonym: () => null,
        recordEvent: () => undefined,
        recordOperation: () => {
          throw new Error(`telemetry down ${content} ${agent}`);
        },
      }).parseAsync(['work', 'inspect'], { from: 'user' });
      expect(process.exitCode).toBe(0);
      expect(output.stdout()).toContain('"scope"');
      expect(output.stderr()).not.toContain('telemetry down');
    } finally {
      process.chdir(savedCwd);
      process.exitCode = savedExit;
      restore('HOME', savedHome);
      restore('USERPROFILE', savedProfile);
      restore('XDG_CACHE_HOME', savedCache);
      restore('CONCORD_NO_UPDATE_CHECK', savedUpdateCheck);
      restore('CONCORD_REPO_ROOT', savedRepo);
      restore('CLAUDE_PROJECT_DIR', savedClaude);
      restore('DEVIN_PROJECT_DIR', savedDevin);
      restore('CONCORD_AGENT_ID', savedAgent);
    }
  });

  it('prints a failed run as JSON on stdout and text on stderr, and sets exit code 1', async () => {
    const wide = writeInput('wide.json', Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]));
    const previous = process.exitCode;
    const output = captureOutput();
    try {
      await cli().parseAsync(['work', 'start', '--json', wide], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(errorSchema.parse(JSON.parse(output.stdout()))).toEqual({
        error: 'The input is UTF-16; save it as UTF-8.',
      });
      expect(output.stderr()).toBe('The input is UTF-16; save it as UTF-8.\n');
    } finally {
      process.exitCode = previous;
    }
  });
});

describe('concord work in agent guidance', () => {
  it('offers the shell path next to the MCP tools', () => {
    for (const text of [
      CONCORD_INSTRUCTIONS,
      CONCORD_GLOBAL_INSTRUCTIONS,
      CONCORD_SERVER_INSTRUCTIONS,
      CONCORD_SERVER_ONLY,
    ]) {
      expect(text).toContain('concord work');
    }
    expect(CONCORD_INSTRUCTIONS).toContain('start_work');
    expect(CONCORD_SERVER_ONLY).toContain('MCP server');
  });
});
