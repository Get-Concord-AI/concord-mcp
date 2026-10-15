import { z } from 'zod';

import type { Repositories } from '../../db/index.js';
import { renderedMessageIds } from '../../domain/pull-inbox.js';

/**
 * What a session's own hooks reveal about the messages its monitor handed it.
 *
 * A harness monitor drains a message the moment it arrives, but the harness
 * may hold the notification — for as long as the agent is blocked on a
 * question or permission prompt for its user. Only the session can say when
 * the agent was actually shown it, and only a fresh session can tell that
 * whatever its predecessor was holding died with it.
 */

/** The parts of a Claude Code hook payload this reads; everything else is ignored. */
const observedHookSchema = z
  .object({
    hook_event_name: z.string(),
    /** SessionStart: startup, resume, clear, or compact. */
    source: z.string().optional(),
    /** UserPromptSubmit: the prompt, including a monitor notification that started the turn. */
    prompt: z.string().optional(),
  })
  .loose();

export interface Observation {
  /** Messages this event proved the agent was shown. */
  seen: string[];
  /** Unseen messages returned to the queue for this agent's new session. */
  requeued: string[];
}

const NOTHING: Observation = { seen: [], requeued: [] };

/**
 * Apply one hook event to `agentId`'s messages.
 *
 * - `UserPromptSubmit` carries the text that started the turn. A monitor
 *   notification arrives this way, so any message rendered in it was seen.
 * - `SessionStart` from `startup` is a new session for this agent: anything
 *   delivered to an earlier session but never shown is queued again. A
 *   `resume` restores the earlier session along with what it was holding, so
 *   requeueing there would show the agent the same message twice.
 */
export function observeHookEvent(
  repos: Repositories,
  agentId: string,
  rawJson: string,
): Observation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return NOTHING;
  }
  const result = observedHookSchema.safeParse(parsed);
  if (!result.success) return NOTHING;
  const event = result.data;

  if (event.hook_event_name === 'UserPromptSubmit' && event.prompt !== undefined) {
    const seen = repos.agentMessages.markSeen(agentId, renderedMessageIds(event.prompt), 'prompt');
    return { seen: seen.map((message) => message.messageId), requeued: [] };
  }
  if (event.hook_event_name === 'SessionStart' && event.source === 'startup') {
    const requeued = repos.agentMessages.requeueUnseen(agentId);
    return { seen: [], requeued: requeued.map((message) => message.messageId) };
  }
  return NOTHING;
}

/**
 * A turn in `agentId`'s session is ending (its Stop hook). Any notification the
 * monitor handed the harness before now was shown to the agent during that
 * turn — including one held while the agent was blocked on its user, since the
 * turn could only end after the user answered.
 */
export function observeTurnEnd(repos: Repositories, agentId: string, now = new Date()): string[] {
  return repos.agentMessages
    .markSeenDeliveredBy(agentId, now.toISOString(), 'stop')
    .map((message) => message.messageId);
}
