import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { McpServerSpec } from '../support/installed.js';
import { McpSession, type JsonObject } from '../support/mcp.js';
import { eventually, parseDelivered, type Channel, type Delivered } from '../support/messages.js';
import { runShell, type CommandResult, type Sandbox } from '../support/sandbox.js';

/**
 * One simulated session of a real harness. Subclasses replay that harness's
 * lifecycle — hook payloads, environment, output envelopes — using the
 * commands `concord setup` installed, and connect to the installed MCP server
 * the way that harness launches it.
 */

/** Whether the receiver is mid-turn or sitting at the prompt when a message lands. */
export type ReceiverState = 'busy' | 'idle';

export interface EndTurn {
  /** The harness would keep the turn going instead of stopping. */
  continued: boolean;
  messages: Delivered[];
}

const workflowResultSchema = z.object({ agent_id: z.string() }).loose();

export abstract class HarnessSession {
  abstract readonly harness: string;
  /** False where the harness hides its session from the MCP server (Codex, Cursor). */
  abstract readonly mcpKnowsSession: boolean;
  /**
   * The states its adapter can deliver a message in, per its catalog entry in
   * `src/domain/harness-config.ts`. Empty for a harness that cannot receive.
   */
  abstract readonly reach: readonly ReceiverState[];

  readonly sessionId = randomUUID();
  private learnedAgentId: string | undefined;
  private mcp: McpSession | undefined;
  private readonly children = new Set<ChildProcess>();

  constructor(protected readonly sandbox: Sandbox) {}

  /** The id Concord should derive for this session, computed independently of Concord. */
  expectedAgentId(): string {
    const hash = createHash('sha256').update(this.sessionId).digest('hex').slice(0, 8);
    return `${this.harness}:${hash}`;
  }

  /** The id the harness was told at session start. */
  get agentId(): string {
    if (this.learnedAgentId === undefined) throw new Error(`${this.harness} has not started.`);
    return this.learnedAgentId;
  }

  protected learnAgentId(agentId: string): void {
    this.learnedAgentId = agentId;
  }

  /** The state the receiver will be in when a message lands. */
  protected receiverState: ReceiverState = 'busy';

  /** Set before SessionStart, for harnesses that decide up front (Codex's controller). */
  prepare(state: ReceiverState): void {
    this.receiverState = state;
  }

  /** Fire SessionStart; learns the agent id the session is told. */
  abstract start(): Promise<void>;
  /** The session's busy-path hooks for one step; returns what they injected. */
  abstract receiveBusy(): Promise<Delivered[]>;
  /** End the turn (Stop-style hook). */
  abstract endTurn(): Promise<EndTurn>;
  /** Whatever keeps an idle session reachable; resolves once it is running. */
  abstract startIdleReceiver(): Promise<void>;
  /** Messages the idle receiver has surfaced so far. */
  abstract idleReceived(): Delivered[];

  protected abstract mcpServer(): McpServerSpec;
  protected abstract mcpEnv(): Record<string, string>;

  private async connection(): Promise<McpSession> {
    this.mcp ??= await McpSession.connect(this.mcpServer(), {
      cwd: this.sandbox.repo,
      env: this.mcpEnv(),
    });
    return this.mcp;
  }

  async toolNames(): Promise<string[]> {
    return (await this.connection()).toolNames();
  }

  /** Call a Concord tool from inside this session, as its model would. */
  async call<T>(tool: string, args: JsonObject, schema: z.ZodType<T>): Promise<T> {
    // A model whose MCP server cannot see its session passes the id it was told.
    const withId = this.mcpKnowsSession ? args : { agent_id: this.agentId, ...args };
    return (await this.connection()).call(tool, withId, schema);
  }

  /** The agent id the MCP server acts as for this session. */
  async mcpAgentId(): Promise<string> {
    const result = await this.call(
      'start_work',
      { task_id: `identity-${this.sessionId}`, title: 'Identity probe', kind: this.harness },
      workflowResultSchema,
    );
    return result.agent_id;
  }

  async waitForIdle(messageId: string, timeoutMs = 15_000): Promise<Delivered> {
    return eventually(
      () => this.idleReceived().find((message) => message.messageId === messageId),
      `${this.harness} idle receiver to surface ${messageId}`,
      timeoutMs,
    );
  }

  /** Run installed hook commands in order with this session's payload. */
  protected async runHooks(
    commands: readonly string[],
    payload: JsonObject,
    env: NodeJS.ProcessEnv,
  ): Promise<CommandResult[]> {
    const results: CommandResult[] = [];
    for (const command of commands) {
      const result = await runShell(command, {
        cwd: this.sandbox.repo,
        env,
        input: JSON.stringify(payload),
      });
      if (result.status !== 0 && result.status !== 2) {
        throw new Error(
          `${this.harness} hook failed (${String(result.status)}): ${command}\n${result.stderr}`,
        );
      }
      results.push(result);
    }
    return results;
  }

  /** Start a long-lived process the way a harness starts a monitor; collects stdout. */
  protected spawnMonitor(
    command: string,
    env: NodeJS.ProcessEnv,
    onOutput: (text: string) => void,
  ): ChildProcess {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: this.sandbox.repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout.on('data', (chunk: Buffer) => {
      onOutput(chunk.toString('utf8'));
    });
    child.stderr.resume();
    this.children.add(child);
    child.once('exit', () => this.children.delete(child));
    return child;
  }

  async close(): Promise<void> {
    for (const child of this.children) {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
    }
    await this.mcp?.close();
  }
}

/** Extract delivered messages from each hook's stdout with `extract`. */
export function deliveredFrom(
  results: readonly CommandResult[],
  via: Channel,
  extract: (stdout: string) => string | undefined,
): Delivered[] {
  return results.flatMap((result) => {
    const stdout = result.stdout.trim();
    if (stdout === '') return [];
    const text = extract(stdout);
    return text === undefined ? [] : parseDelivered(text, via);
  });
}

/** Parse a hook's stdout as JSON with `schema`, or undefined when it is not that shape. */
export function hookJson<T>(stdout: string, schema: z.ZodType<T>): T | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** The id a `concord inbox register` line names, e.g. "this session is agent `codex:1a2b3c4d`". */
export function registeredAgentId(output: string): string | undefined {
  return /this session is agent `([^`]+)`/u.exec(output)?.[1];
}
