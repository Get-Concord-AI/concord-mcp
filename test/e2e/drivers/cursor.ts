import { join } from 'node:path';

import { z } from 'zod';

import {
  cursorHooks,
  hookCommands,
  mcpServerFromJson,
  type McpServerSpec,
} from '../support/installed.js';
import { parseDelivered, type Delivered } from '../support/messages.js';
import { stringEnv } from './claude-code.js';
import { deliveredFrom, HarnessSession, hookJson, type EndTurn } from './session.js';

const sessionStartSchema = z.object({
  env: z.record(z.string(), z.string()),
  additional_context: z.string(),
});
const stopSchema = z.object({ followup_message: z.string() });

/**
 * Cursor: user-level hooks run the relay extension's `cursor-hook.mjs`, which
 * tells the agent its id and the monitor command to run in a background Shell.
 * The monitor is one-shot: it exits with the first batch, which resumes the
 * agent. A busy session is reached by the stop hook's follow-up message.
 */
export class CursorSession extends HarnessSession {
  readonly harness = 'cursor';
  readonly mcpKnowsSession = false;
  private monitorCommand: string | undefined;
  private readonly monitorOutput: string[] = [];
  /** Cursor applies a sessionStart hook's `env` to the session's later hooks. */
  private sessionEnv: Record<string, string> = {};

  private env(): NodeJS.ProcessEnv {
    return this.sandbox.env(this.sessionEnv);
  }

  private payload(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      conversation_id: this.sessionId,
      generation_id: `${this.sessionId}-gen`,
      hook_event_name: event,
      workspace_roots: [this.sandbox.repo],
      ...extra,
    };
  }

  async start(): Promise<void> {
    const [result] = await this.runHooks(
      hookCommands(cursorHooks(this.sandbox.home), 'sessionStart'),
      this.payload('sessionStart'),
      this.env(),
    );
    const output = hookJson(result?.stdout.trim() ?? '', sessionStartSchema);
    if (output === undefined) {
      throw new Error(`Cursor sessionStart gave no identity: ${result?.stdout ?? ''}`);
    }
    const agentId = output.env['CONCORD_AGENT_ID'];
    if (agentId === undefined) throw new Error('Cursor sessionStart set no CONCORD_AGENT_ID.');
    this.sessionEnv = output.env;
    this.learnAgentId(agentId);
    this.monitorCommand = /with: (concord inbox watch [^\n]*?--once)/u.exec(
      output.additional_context,
    )?.[1];
  }

  /** Cursor has no tool-result hook; a busy turn is reached as it stops. */
  async receiveBusy(): Promise<Delivered[]> {
    return (await this.endTurn()).messages;
  }

  async endTurn(): Promise<EndTurn> {
    const results = await this.runHooks(
      hookCommands(cursorHooks(this.sandbox.home), 'stop'),
      this.payload('stop', { status: 'completed', loop_count: 0 }),
      this.env(),
    );
    const messages = deliveredFrom(
      results,
      (stdout) => hookJson(stdout, stopSchema)?.followup_message,
    );
    return { continued: messages.length > 0, messages };
  }

  startIdleReceiver(): Promise<void> {
    if (this.monitorCommand === undefined) {
      throw new Error('Cursor sessionStart did not tell the agent how to start its monitor.');
    }
    this.spawnMonitor(this.monitorCommand, this.env(), (text) => this.monitorOutput.push(text));
    return Promise.resolve();
  }

  idleReceived(): Delivered[] {
    return parseDelivered(this.monitorOutput.join(''));
  }

  protected mcpServer(): McpServerSpec {
    return mcpServerFromJson(join(this.sandbox.repo, '.cursor', 'mcp.json'));
  }

  protected mcpEnv(): Record<string, string> {
    return stringEnv(this.sandbox.env());
  }
}
