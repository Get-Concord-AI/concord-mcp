import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  ): HarnessRun {
    const argv = mode === 'headless' ? harness.headless(prompt) : harness.interactive(prompt);
    const log = join(sandbox.root, `${harness.name}-${mode}-${randomUUID().slice(0, 6)}.log`);
    const [command, ...args] =
      mode === 'interactive' && harness.idle === 'tui' ? ['python3', PTY_RUN, log, ...argv] : argv;
    if (command === undefined) throw new Error(`${harness.name} has no ${mode} command.`);
    const child = spawn(command, args, {
      cwd: sandbox.repo,
      env: sandbox.env(harness.env(model)),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const run = new HarnessRun(child, log);
    const collect = (chunk: Buffer): void => {
      run.output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    return run;
  }

  /** What the harness printed, or for a pseudo-terminal session its screen log. */
  transcript(): string {
    let screen = '';
    try {
      screen = readFileSync(this.log, 'utf8');
    } catch {
      // Headless runs have no screen log.
    }
    return `${this.output}${screen}`.slice(-4000);
  }

  stop(): void {
    if (this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch {
      // Already exited.
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

  close(): Promise<void> {
    return this.mcp.close();
  }
}
