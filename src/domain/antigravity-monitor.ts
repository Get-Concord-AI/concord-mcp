import { z } from 'zod';

import { HARNESS_CONFIGS } from './harness-config.js';
import { renderInboxBody, type DeliverableMessage } from './pull-inbox.js';

/**
 * Antigravity wakes an idle session only when one of its background commands
 * completes, so the agent itself must launch Concord's one-shot monitor, and
 * launch a fresh one after each delivery. A SessionStart system message alone
 * is not reliably acted on, so the first model call of every turn asks for the
 * monitor while no watcher holds the session's receiver.
 */

const preInvocationSchema = z.object({ invocationNum: z.number().optional() }).loose();

/** The monitor command for this agent. */
export function antigravityMonitorCommand(agentId: string): string {
  return (HARNESS_CONFIGS.antigravity.monitor.command ?? '').replace('<agent-id>', agentId);
}

/**
 * The step asking the agent to start its monitor, or undefined when one is
 * watching or this is not the first model call of the turn.
 */
export function antigravityMonitorNudge(
  rawPayload: string,
  agentId: string,
  watching: boolean,
): string | undefined {
  if (watching) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return undefined;
  }
  const result = preInvocationSchema.safeParse(parsed);
  if (!result.success || result.data.invocationNum !== 0) return undefined;
  return (
    'Concord: this session is not watching for messages from other agents. Before anything ' +
    `else, start exactly one background command for \`${antigravityMonitorCommand(agentId)}\`. ` +
    'Do not wait on it or poll it; carry on with the request. When it completes with a ' +
    'message, answer that message and start a fresh one.'
  );
}

/** Delivered messages, then any request to start the monitor, as Antigravity user steps. */
export function antigravityInjectSteps(
  messages: readonly DeliverableMessage[],
  nudge: string | undefined,
): { userMessage: string }[] {
  return [
    ...(messages.length === 0
      ? []
      : [{ userMessage: `[concord] Incoming message(s):\n\n${renderInboxBody(messages)}` }]),
    ...(nudge === undefined ? [] : [{ userMessage: nudge }]),
  ];
}
