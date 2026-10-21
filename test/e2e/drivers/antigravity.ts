import { join } from 'node:path';

import { z } from 'zod';

import {
  antigravityHooks,
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

const injectStepsSchema = z.object({
  injectSteps: z.array(
    z.object({
      systemMessage: z.string().optional(),
      ephemeralMessage: z.string().optional(),
      userMessage: z.string().optional(),
    }),
  ),
});
const stopSchema = z.object({ decision: z.literal('continue'), reason: z.string() });

/**
 * Antigravity (headless `agy`): the conversation id arrives only in hook
 * payloads, so the model passes the id SessionStart told it. Workspace hooks
 * inject messages before each model invocation and keep a stopping turn going.
 * Nothing reaches an idle session.
 */
export class AntigravitySession extends HarnessSession {
  readonly harness = 'antigravity';
  readonly mcpKnowsSession = false;
  readonly reach = ['busy'] as const;

  private env(): NodeJS.ProcessEnv {
    return this.sandbox.env();
  }

  private payload(extra: JsonObject = {}): JsonObject {
    return { conversationId: this.sessionId, workspacePaths: [this.sandbox.repo], ...extra };
  }

  private hooks(event: string): string[] {
    return hookCommands(antigravityHooks(this.sandbox.repo), event);
  }

  async start(): Promise<void> {
    const results = await this.runHooks(this.hooks('SessionStart'), this.payload(), this.env());
    const told = results.flatMap(
      (result) =>
        hookJson(result.stdout.trim(), injectStepsSchema)?.injectSteps.map(
          (step) => step.systemMessage ?? step.ephemeralMessage ?? '',
        ) ?? [],
    );
    const agentId = told.map((message) => registeredAgentId(message)).find(Boolean);
    if (agentId === undefined) throw new Error('Antigravity SessionStart named no agent id.');
    this.learnAgentId(agentId);
  }

  /** PreInvocation runs before every model call, so it is how a busy turn hears. */
  async receiveBusy(): Promise<Delivered[]> {
    const results = await this.runHooks(this.hooks('PreInvocation'), this.payload(), this.env());
    return deliveredFrom(results, 'pre-invocation', (stdout) =>
      hookJson(stdout, injectStepsSchema)
        ?.injectSteps.map((step) => step.userMessage ?? '')
        .join('\n'),
    );
  }

  async endTurn(): Promise<EndTurn> {
    const results = await this.runHooks(this.hooks('Stop'), this.payload(), this.env());
    const messages = deliveredFrom(
      results,
      'stop',
      (stdout) => hookJson(stdout, stopSchema)?.reason,
    );
    return { continued: messages.length > 0, messages };
  }

  startIdleReceiver(): Promise<void> {
    return Promise.reject(new Error('Antigravity has no idle receiver.'));
  }

  idleReceived(): Delivered[] {
    return [];
  }

  protected mcpServer(): McpServerSpec {
    return mcpServerFromJson(join(this.sandbox.repo, '.agents', 'mcp_config.json'));
  }

  protected mcpEnv(): Record<string, string> {
    return stringEnv(this.env());
  }
}
