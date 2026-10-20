import { z } from 'zod';

import { codexConfig, hookCommands, type McpServerSpec } from '../support/installed.js';
import type { JsonObject } from '../support/mcp.js';
import { eventually, parseDelivered, type Delivered } from '../support/messages.js';
import { stringEnv } from './claude-code.js';
import {
  deliveredFrom,
  HarnessSession,
  hookJson,
  registeredAgentId,
  type EndTurn,
  type ReceiverState,
} from './session.js';

/** The environment Codex gives MCP servers: nothing that names the session. */
const CODEX_MCP_ENV = ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER'];

const postToolUseSchema = z.object({
  hookSpecificOutput: z.object({ additionalContext: z.string() }).loose(),
});
const stopSchema = z.object({ decision: z.literal('block'), reason: z.string() });
const appServerRequestSchema = z.object({
  method: z.string().optional(),
  params: z
    .object({
      threadId: z.string().optional(),
      input: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    })
    .loose()
    .nullable(),
});

const endpointViewSchema = z
  .object({ promptable: z.boolean(), capabilities: z.array(z.string()) })
  .loose();

type AppServerMode = 'idle' | 'busy' | 'down';

/**
 * Codex: MCP servers get a scrubbed environment, so the session id arrives
 * only on hook stdin and the model passes the id SessionStart told it.
 * SessionStart launches a detached Concord host that drives the session
 * through Codex's app-server — `turn/start` when idle, `turn/steer` when busy.
 * The sandbox's fake app-server records both.
 */
export class CodexSession extends HarnessSession {
  readonly harness = 'codex';
  readonly mcpKnowsSession = false;
  private mode: AppServerMode = 'idle';
  /** Steers already reported by `receiveBusy`, which, like a hook, hands each over once. */
  private steersSeen = 0;

  /** `down` leaves the session reachable only through its hooks. */
  setController(mode: AppServerMode): void {
    this.mode = mode;
  }

  override prepare(state: ReceiverState): void {
    super.prepare(state);
    this.mode = state;
  }

  private env(): NodeJS.ProcessEnv {
    return this.sandbox.env();
  }

  private payload(event: string, extra: JsonObject = {}): JsonObject {
    return {
      session_id: this.sessionId,
      cwd: this.sandbox.repo,
      hook_event_name: event,
      model: 'gpt-5-codex',
      ...extra,
    };
  }

  async start(): Promise<void> {
    this.sandbox.setCodexAppServer(this.mode);
    const results = await this.runHooks(
      hookCommands(codexConfig(this.sandbox.home).hooks, 'SessionStart'),
      this.payload('SessionStart', { source: 'startup' }),
      this.env(),
    );
    const agentId = results.map((result) => registeredAgentId(result.stdout)).find(Boolean);
    if (agentId === undefined) throw new Error('Codex SessionStart named no agent id.');
    this.learnAgentId(agentId);
    // The host SessionStart launched owns the endpoint only once its relay is
    // registered, which happens after it resumes the thread.
    if (this.mode !== 'down') {
      await eventually(async () => {
        const view = await this.call('inspect_work', { agent_id: agentId }, endpointViewSchema);
        return view.promptable && view.capabilities.includes('inject') ? true : undefined;
      }, 'the Codex host to register its relay endpoint');
    }
  }

  /** Turns the fake app-server was asked to start or steer for this thread. */
  private appServerTurns(method: 'turn/start' | 'turn/steer'): Delivered[] {
    return this.sandbox.codexAppServerLog().flatMap((line) => {
      const request = appServerRequestSchema.parse(JSON.parse(line));
      if (request.method !== method || request.params?.threadId !== this.sessionId) return [];
      return parseDelivered(
        (request.params.input ?? []).map((part) => part.text ?? '').join('\n'),
        method,
      );
    });
  }

  async receiveBusy(): Promise<Delivered[]> {
    const results = await this.runHooks(
      hookCommands(codexConfig(this.sandbox.home).hooks, 'PostToolUse'),
      this.payload('PostToolUse', { tool_name: 'shell', tool_input: { command: ['ls'] } }),
      this.env(),
    );
    const hooked = deliveredFrom(
      results,
      'post-tool-use',
      (stdout) => hookJson(stdout, postToolUseSchema)?.hookSpecificOutput.additionalContext,
    );
    const steers = this.appServerTurns('turn/steer');
    const newSteers = steers.slice(this.steersSeen);
    this.steersSeen = steers.length;
    return [...newSteers, ...hooked];
  }

  async endTurn(): Promise<EndTurn> {
    const results = await this.runHooks(
      hookCommands(codexConfig(this.sandbox.home).hooks, 'Stop'),
      this.payload('Stop', { stop_hook_active: false }),
      this.env(),
    );
    const messages = deliveredFrom(
      results,
      'stop',
      (stdout) => hookJson(stdout, stopSchema)?.reason,
    );
    return { continued: messages.length > 0, messages };
  }

  /** Codex needs no monitor: the host SessionStart launched is its idle receiver. */
  startIdleReceiver(): Promise<void> {
    return Promise.resolve();
  }

  idleReceived(): Delivered[] {
    return this.appServerTurns('turn/start');
  }

  protected mcpServer(): McpServerSpec {
    return codexConfig(this.sandbox.home).mcp;
  }

  protected mcpEnv(): Record<string, string> {
    const env = stringEnv(this.env());
    return Object.fromEntries(Object.entries(env).filter(([key]) => CODEX_MCP_ENV.includes(key)));
  }
}
