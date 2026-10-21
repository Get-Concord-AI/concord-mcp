import { join } from 'node:path';

import { z } from 'zod';

import {
  copilotHooks,
  hookCommands,
  mcpServerFromJson,
  type McpServerSpec,
} from '../support/installed.js';
import type { JsonObject } from '../support/mcp.js';
import type { Delivered } from '../support/messages.js';
import { stringEnv } from './claude-code.js';
import {
  deliveredFrom,
  HarnessSession,
  hookJson,
  registeredAgentId,
  type EndTurn,
} from './session.js';

const contextSchema = z.object({ additionalContext: z.string() });
const stopSchema = z.object({ decision: z.literal('block'), reason: z.string() });

/**
 * A plain `copilot` session: user-level hooks get the session id in their
 * payload and the MCP server gets it as `COPILOT_AGENT_SESSION_ID`. Messages
 * arrive after each tool call and, when one lands after the last, by blocking
 * the stop. Waking an idle session needs `concord adapters copilot` and its
 * embedded server, which the real-harness suite covers with the real binary.
 */
export class CopilotSession extends HarnessSession {
  readonly harness = 'copilot-cli';
  readonly mcpKnowsSession = true;
  readonly reach = ['busy'] as const;

  private payload(extra: JsonObject = {}): JsonObject {
    return { sessionId: this.sessionId, timestamp: Date.now(), cwd: this.sandbox.repo, ...extra };
  }

  private hooks(event: string): string[] {
    return hookCommands(copilotHooks(this.sandbox.home), event);
  }

  async start(): Promise<void> {
    const results = await this.runHooks(
      this.hooks('sessionStart'),
      this.payload({ source: 'new' }),
      this.sandbox.env(),
    );
    const told = results.map(
      (result) => hookJson(result.stdout.trim(), contextSchema)?.additionalContext ?? '',
    );
    const agentId = told.map((message) => registeredAgentId(message)).find(Boolean);
    if (agentId === undefined) throw new Error('Copilot sessionStart named no agent id.');
    this.learnAgentId(agentId);
  }

  async receiveBusy(): Promise<Delivered[]> {
    const results = await this.runHooks(
      this.hooks('postToolUse'),
      this.payload({
        toolName: 'bash',
        toolArgs: { command: 'true' },
        toolResult: { resultType: 'success', textResultForLlm: '' },
      }),
      this.sandbox.env(),
    );
    return deliveredFrom(
      results,
      'post-tool-use',
      (stdout) => hookJson(stdout, contextSchema)?.additionalContext,
    );
  }

  async endTurn(): Promise<EndTurn> {
    const results = await this.runHooks(
      this.hooks('agentStop'),
      this.payload({ stopReason: 'end_turn', stop_hook_active: false }),
      this.sandbox.env(),
    );
    const messages = deliveredFrom(
      results,
      'stop',
      (stdout) => hookJson(stdout, stopSchema)?.reason,
    );
    return { continued: messages.length > 0, messages };
  }

  startIdleReceiver(): Promise<void> {
    return Promise.reject(new Error('A plain Copilot session has no idle receiver.'));
  }

  idleReceived(): Delivered[] {
    return [];
  }

  protected mcpServer(): McpServerSpec {
    return mcpServerFromJson(join(this.sandbox.home, '.copilot', 'mcp-config.json'));
  }

  protected mcpEnv(): Record<string, string> {
    return stringEnv(this.sandbox.env({ COPILOT_AGENT_SESSION_ID: this.sessionId }));
  }
}
