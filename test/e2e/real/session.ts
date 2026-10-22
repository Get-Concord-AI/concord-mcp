import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { McpSession } from '../support/mcp.js';
import { eventually } from '../support/messages.js';
import { stringEnv } from '../drivers/claude-code.js';
import type { Sandbox } from '../support/sandbox.js';
import { sentSchema, type Sent } from '../support/scenario.js';
import type { FakeModel } from './fake-model/server.js';
import type { RealHarness } from './harnesses.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Drop CSI (`ESC [ … letter`) and OSC (`ESC ] … BEL|ESC \\`) sequences from a screen log. */
function stripControls(raw: string): string {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== ESC) {
      out += raw[index] ?? '';
      continue;
    }
    const kind = raw[index + 1];
    index += 1;
    if (kind === '[') {
      while (index + 1 < raw.length && !/[a-zA-Z~]/u.test(raw[index + 1] ?? '')) index += 1;
      index += 1;
    } else if (kind === ']') {
      while (index + 1 < raw.length && raw[index + 1] !== BEL && raw[index + 1] !== ESC) {
        index += 1;
      }
      index += raw[index + 1] === ESC ? 2 : 1;
    }
  }
  return out;
}

const PTY_RUN = join(dirname(fileURLToPath(import.meta.url)), 'pty-run.py');

/** A real harness process: headless for one turn, or interactive in a pseudo-terminal. */
export class HarnessRun {
  private output = '';

  private constructor(
    private readonly child: ChildProcessByStdio<null, Readable, Readable>,
    private readonly log: string,
  ) {}

  static start(
    sandbox: Sandbox,
    harness: RealHarness,
    model: FakeModel,
    mode: 'headless' | 'interactive',
    prompt: string,
    extraEnv: Record<string, string> = {},
  ): HarnessRun {
    const argv = mode === 'headless' ? harness.headless(prompt) : harness.interactive(prompt);
    const log = join(sandbox.root, `${harness.name}-${mode}-${randomUUID().slice(0, 6)}.log`);
    const [command, ...args] =
      mode === 'interactive' && harness.idle === 'tui' ? ['python3', PTY_RUN, log, ...argv] : argv;
    if (command === undefined) throw new Error(`${harness.name} has no ${mode} command.`);
    const child = spawn(command, args, {
      cwd: sandbox.repo,
      env: sandbox.env({ ...harness.env(model), ...extraEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const run = new HarnessRun(child, log);
    const collect = (chunk: Buffer): void => {
      run.output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    // Say so when the harness never started or quit early: a silent, empty
    // transcript is otherwise all a failure shows.
    child.once('error', (error) => {
      run.output += `\n[spawn ${command} failed: ${error.message}]\n`;
    });
    child.once('exit', (code, signal) => {
      run.output += `\n[${command} exited: code=${String(code)} signal=${String(signal)}]\n`;
    });
    return run;
  }

  /** Wait until the pseudo-terminal screen shows `text`. */
  async untilScreen(text: string, description: string, timeoutMs = 60_000): Promise<void> {
    await eventually(
      () => (this.screen().includes(text) ? true : undefined),
      description,
      timeoutMs,
    );
  }

  /** The whole screen log so far, without terminal control sequences. */
  screen(): string {
    try {
      return stripControls(readFileSync(this.log, 'utf8'));
    } catch {
      return '';
    }
  }

  /** Kill the whole session without warning, as a crash would: no hook gets to run. */
  crash(): void {
    if (this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }

  /** Type into a pseudo-terminal session (see pty-run.py). */
  type(keys: string): void {
    writeFileSync(`${this.log}.keys`, keys);
  }

  /** What the harness printed, or for a pseudo-terminal session its screen log. */
  transcript(): string {
    let screen = '';
    try {
      screen = readFileSync(this.log, 'utf8');
    } catch {
      // Headless runs have no screen log.
    }
    const where = `[screen log ${this.log}: ${screen === '' ? 'empty or missing' : `${String(screen.length)} bytes`}]\n`;
    return `${where}${this.output}${stripControls(screen)}`.slice(-4000);
  }

  /**
   * Stop the session and wait until it has really gone, so the next case
   * never starts while this one still holds a port, a lock or a pty: SIGTERM
   * first, then SIGKILL for anything still alive after a few seconds.
   */
  async stop(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined || this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      this.child.once('exit', () => {
        resolve();
      });
    });
    const signal = (name: NodeJS.Signals): void => {
      try {
        process.kill(-pid, name);
      } catch {
        // Already exited.
      }
    };
    signal('SIGTERM');
    const timer = new Promise<'timeout'>((resolve) =>
      setTimeout(() => {
        resolve('timeout');
      }, 5_000),
    );
    if ((await Promise.race([exited, timer])) === 'timeout') {
      signal('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  }
}

const presenceSchema = z
  .object({ presence: z.array(z.object({ agentId: z.string() }).loose()) })
  .loose();
const inboxSchema = z
  .object({
    inbox: z.array(
      z
        .object({
          messageId: z.string(),
          senderAgentId: z.string(),
          replyToMessageId: z.string().nullable(),
          content: z.string(),
        })
        .loose(),
    ),
  })
  .loose();
export type InboxMessage = z.infer<typeof inboxSchema>['inbox'][number];

/**
 * A scripted peer in the workspace: no harness, no model, just Concord's MCP
 * server under an operator-chosen id, with a pull endpoint so it can be sent to.
 */
export class Probe {
  private constructor(
    readonly agentId: string,
    private readonly mcp: McpSession,
  ) {}

  static async start(sandbox: Sandbox): Promise<Probe> {
    const agentId = `probe:${randomUUID().slice(0, 6)}`;
    await sandbox.concord(['inbox', 'register', '--agent', agentId, '--provider', 'claude-code']);
    const mcp = await McpSession.connect(
      { command: 'concord-mcp', args: [], env: {} },
      { cwd: sandbox.repo, env: stringEnv(sandbox.env({ CONCORD_AGENT_ID: agentId })) },
    );
    return new Probe(agentId, mcp);
  }

  /** The id of the first `kind` session to register in the workspace. */
  async sessionOf(kind: string, timeoutMs = 60_000): Promise<string> {
    return eventually(
      async () => {
        const view = await this.mcp.call('inspect_work', {}, presenceSchema);
        return view.presence.find((entry) => entry.agentId.startsWith(`${kind}:`))?.agentId;
      },
      `a ${kind} session to register`,
      timeoutMs,
    );
  }

  /** Call any Concord tool as the probe, for checks the helpers below do not cover. */
  call<T>(tool: string, args: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    return this.mcp.call(tool, args, schema);
  }

  /** What the probe can see of another agent's endpoint and inbox. */
  inspect<T>(agentId: string, schema: z.ZodType<T>): Promise<T> {
    return this.mcp.call('inspect_work', { agent_id: agentId }, schema);
  }

  send(to: string, content: string): Promise<Sent> {
    return this.mcp.call(
      'update_work',
      { operation: 'prompt', to_agent_id: to, content, idempotency_key: randomUUID() },
      sentSchema,
    );
  }

  /** A message in the probe's inbox matching `predicate`, once it arrives. */
  async received(
    predicate: (message: InboxMessage) => boolean,
    description: string,
    timeoutMs = 60_000,
  ): Promise<InboxMessage> {
    return eventually(
      async () => {
        const view = await this.mcp.call('inspect_work', { agent_id: this.agentId }, inboxSchema);
        return view.inbox.find(predicate);
      },
      description,
      timeoutMs,
    );
  }

  /** The receipt of a message the probe sent, with the evidence behind its read tick. */
  async receipt(messageId: string): Promise<ProbeReceipt> {
    const view = await this.mcp.call('inspect_work', { message_id: messageId }, threadSchema);
    const message = view.thread.find((entry) => entry.messageId === messageId);
    if (message === undefined) throw new Error(`Message ${messageId} is not visible to the probe.`);
    const events = view.events.filter((event) => event.messageId === messageId);
    return {
      ...message.receipt,
      deliveredVia: message.deliveredVia,
      readEvidence: events.find((event) => event.event === 'read')?.detail ?? null,
      events: events.map((event) => event.event),
    };
  }

  /** Wait for a message's receipt to satisfy `predicate`. */
  async receiptUntil(
    messageId: string,
    predicate: (receipt: ProbeReceipt) => boolean,
    description: string,
    timeoutMs = 60_000,
  ): Promise<ProbeReceipt> {
    return eventually(
      async () => {
        const receipt = await this.receipt(messageId);
        return predicate(receipt) ? receipt : undefined;
      },
      description,
      timeoutMs,
    );
  }

  close(): Promise<void> {
    return this.mcp.close();
  }
}

const receiptSchema = z
  .object({
    status: z.string(),
    ticks: z.string(),
    sent_at: z.string(),
    delivered_at: z.string().nullable(),
    read_at: z.string().nullable(),
    replied_at: z.string().nullable(),
  })
  .loose();
const threadSchema = z
  .object({
    thread: z.array(
      z
        .object({
          messageId: z.string(),
          deliveredVia: z.string().nullable(),
          receipt: receiptSchema,
        })
        .loose(),
    ),
    events: z.array(
      z.object({ messageId: z.string(), event: z.string(), detail: z.string().nullable() }).loose(),
    ),
  })
  .loose();
export type ProbeReceipt = z.infer<typeof receiptSchema> & {
  deliveredVia: string | null;
  readEvidence: string | null;
  events: string[];
};
