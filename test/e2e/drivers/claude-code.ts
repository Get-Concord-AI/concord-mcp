import { join } from 'node:path';

import { z } from 'zod';

import {
  claudeHooks,
  claudeMonitorCommand,
  hookCommands,
  mcpServerFromJson,
  type McpServerSpec,
} from '../support/installed.js';
import { parseDelivered, type Delivered } from '../support/messages.js';
import {
  deliveredFrom,
  HarnessSession,
  hookJson,
  registeredAgentId,
  type EndTurn,
} from './session.js';

const postToolUseSchema = z.object({
  hookSpecificOutput: z.object({ additionalContext: z.string() }).loose(),
});
const stopSchema = z.object({ decision: z.literal('block'), reason: z.string() });

/**
 * Claude Code: the session id is in the environment of every child process,
 * hooks come from the relay plugin, and an idle session is reached by the
 * plugin's monitor, whose stdout lines become notifications.
 */
export class ClaudeCodeSession extends HarnessSession {
  readonly harness = 'claude-code';
  readonly mcpKnowsSession = true;
  private readonly monitorOutput: string[] = [];

  private env(): NodeJS.ProcessEnv {
    return this.sandbox.env({ CLAUDE_CODE_SESSION_ID: this.sessionId });
  }

  private payload(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      transcript_path: join(this.sandbox.home, '.claude', 'projects', `${this.sessionId}.jsonl`),
      cwd: this.sandbox.repo,
      hook_event_name: event,
      ...extra,
    };
  }

  async start(): Promise<void> {
    const results = await this.runHooks(
      hookCommands(claudeHooks(this.sandbox.home), 'SessionStart'),
      this.payload('SessionStart', { source: 'startup' }),
      this.env(),
    );
    const agentId = results.map((result) => registeredAgentId(result.stdout)).find(Boolean);
    if (agentId === undefined) throw new Error('Claude SessionStart named no agent id.');
    this.learnAgentId(agentId);
  }

  async receiveBusy(): Promise<Delivered[]> {
    const results = await this.runHooks(
      hookCommands(claudeHooks(this.sandbox.home), 'PostToolUse'),
      this.payload('PostToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { stdout: '', stderr: '' },
      }),
      this.env(),
    );
    return deliveredFrom(
      results,
      (stdout) => hookJson(stdout, postToolUseSchema)?.hookSpecificOutput.additionalContext,
    );
  }

  async endTurn(): Promise<EndTurn> {
    const results = await this.runHooks(
      hookCommands(claudeHooks(this.sandbox.home), 'Stop'),
      this.payload('Stop', { stop_hook_active: false }),
      this.env(),
    );
    const messages = deliveredFrom(results, (stdout) => hookJson(stdout, stopSchema)?.reason);
    return { continued: messages.length > 0, messages };
  }

  startIdleReceiver(): Promise<void> {
    this.spawnMonitor(
      claudeMonitorCommand(this.sandbox.home),
      {
        ...this.env(),
        // Claude Code sets the plugin root to where the plugin is installed.
        CLAUDE_PLUGIN_ROOT: join(this.sandbox.home, '.claude', 'skills', 'concord-relay'),
        CONCORD_INBOX_POLL_SECONDS: '0.5',
      },
      (text) => this.monitorOutput.push(text),
    );
    return Promise.resolve();
  }

  idleReceived(): Delivered[] {
    return parseDelivered(this.monitorOutput.join(''));
  }

  protected mcpServer(): McpServerSpec {
    return mcpServerFromJson(join(this.sandbox.repo, '.mcp.json'));
  }

  protected mcpEnv(): Record<string, string> {
    return stringEnv(this.env());
  }
}

/** A process environment without the unset entries the MCP transport rejects. */
export function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
