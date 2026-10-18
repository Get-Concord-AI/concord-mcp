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
    /** PreToolUse: the tool about to run. */
    tool_name: z.string().optional(),
    /** Notification: why Claude Code is asking for the user's attention. */
    notification_type: z.string().optional(),
    /**
     * Set when the hook fired inside a subagent or a background agent forked
     * from the session, rather than in the session's own conversation.
     */
    agent_id: z.string().optional(),
  })
  .loose();

/** Claude Code's tool that blocks the turn on a question for the user. */
const ASK_USER_TOOL = 'AskUserQuestion';

export interface Observation {
  /** Messages this event proved the agent was shown. */
  seen: string[];
  /** Unseen messages returned to the queue for this agent's new session. */
  requeued: string[];
}

const NOTHING: Observation = { seen: [], requeued: [] };

/**
 * Apply one hook event to `agentId`'s messages and presence.
 *
 * - `PreToolUse` for `AskUserQuestion`, and a `permission_prompt`
 *   notification, mean the session is about to block on its user. Recorded so
 *   a sender can be told; delivery is never held on it, because dismissing a
 *   prompt with Esc or Deny fires no hook to clear it. A question asked
 *   inside a subagent or a forked background agent (`agent_id` set) is not
 *   the session blocking: Claude Code forks one after a turn ends, and its
 *   tool calls still fire the session's hooks.
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

  switch (event.hook_event_name) {
    case 'PreToolUse':
      if (event.tool_name === ASK_USER_TOOL && event.agent_id === undefined) {
        awaitUser(repos, agentId);
      }
      return NOTHING;
    case 'Notification':
      if (event.notification_type === 'permission_prompt') awaitUser(repos, agentId);
      return NOTHING;
    case 'UserPromptSubmit': {
      repos.agentEndpoints.setAwaitingUser(agentId, null);
      const ids = event.prompt === undefined ? [] : renderedMessageIds(event.prompt);
      const seen = repos.agentMessages.markSeen(agentId, ids, 'prompt');
      return { seen: seen.map((message) => message.messageId), requeued: [] };
    }
    case 'SessionStart': {
      repos.agentEndpoints.setAwaitingUser(agentId, null);
      if (event.source !== 'startup') return NOTHING;
      const requeued = repos.agentMessages.requeueUnseen(agentId);
      return { seen: [], requeued: requeued.map((message) => message.messageId) };
    }
    default:
      return NOTHING;
  }
}

function awaitUser(repos: Repositories, agentId: string): void {
  repos.agentEndpoints.setAwaitingUser(agentId, new Date().toISOString());
}

/**
 * A tool call in `agentId`'s session finished (its PostToolUse hook), so
 * whatever it was waiting on its user for has been answered. With parallel
 * tool calls this can clear early; the flag is advisory, so that only costs a
 * sender the warning.
 */
export function observeToolDone(repos: Repositories, agentId: string): void {
  repos.agentEndpoints.setAwaitingUser(agentId, null);
}

/**
 * A turn in `agentId`'s session is ending (its Stop hook). Any notification the
 * monitor handed the harness before now was shown to the agent during that
 * turn — including one held while the agent was blocked on its user, since the
 * turn could only end after the user answered.
 */
export function observeTurnEnd(repos: Repositories, agentId: string, now = new Date()): string[] {
  repos.agentEndpoints.setAwaitingUser(agentId, null);
  return repos.agentMessages
    .markSeenDeliveredBy(agentId, now.toISOString(), 'stop')
    .map((message) => message.messageId);
}
