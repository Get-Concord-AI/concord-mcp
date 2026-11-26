/**
 * The pre-question drain (#208): just before Claude Code opens an
 * `AskUserQuestion` picker, show the session any Concord messages it has not
 * been shown yet, by denying the question with them as the reason.
 *
 * Loaded lazily by `concord inbox drain --format pre-tool-use`, and only on a
 * local store: a linked machine skips the drain before getting here.
 */
import type { Repositories } from '../../db/index.js';
import { capabilityFor } from '../../domain/delivery.js';
import {
  renderHookPayload,
  toDeliverable,
  type DeliverableMessage,
} from '../../domain/pull-inbox.js';
import type { TelemetryRecorder } from '../../telemetry/events.js';
import { resolveInboxOwner } from '../agent-identity.js';
import { isSubagentHook, observeHookEvent, parseObservedHook } from './inbox-observe.js';
import { currentSession, drainInbox, readHookPayload, recordDeliveredMessages } from './inbox.js';

/** What a session should be shown before it blocks on its user. */
export interface BeforeUserWait {
  /** Handed to this session by a monitor whose notification the harness is still holding. */
  held: DeliverableMessage[];
  /** Still queued, claimed now for this session. */
  claimed: DeliverableMessage[];
}

/**
 * How long after a deny the next question is let through without draining.
 * Long enough for the model to read the messages and ask again.
 */
export const USER_WAIT_DENY_WINDOW_MS = 2 * 60 * 1000;

const NOTHING_TO_SHOW: BeforeUserWait = { held: [], claimed: [] };

/** Whether a deny recorded at `deniedAt` still covers a question asked at `now`. */
function deniedRecently(deniedAt: string, now: Date): boolean {
  const elapsed = now.getTime() - Date.parse(deniedAt);
  return elapsed >= 0 && elapsed < USER_WAIT_DENY_WINDOW_MS;
}

/**
 * Everything `agentId`'s session has not been shown, just before it blocks on
 * a question. Claude Code holds a monitor notification until the user answers,
 * so a message the monitor already took counts here too: delivered to this
 * session, with no read evidence yet. Run read observation first, so a message
 * the model has already seen is left out.
 *
 * When there is anything to show, the hook denies the call and the user is
 * not asked yet, so the waiting-on-user flag is cleared.
 *
 * At most one deny per question: the question the same session asks right
 * after a deny is let through untouched, so a message the transcript does not
 * show as read yet, or a peer that keeps sending, can never keep the user from
 * being asked. Anything still waiting reaches the model after the answer, as it
 * would without this hook. Another session of the same agent, or a fresh one,
 * never spends that allowance.
 *
 * Runs as one immediate transaction: the monitor, in another process, cannot
 * claim a message between listing what it holds and claiming what is queued,
 * which would leave a message in neither list.
 */
export function drainBeforeUserWait(
  repos: Repositories,
  agentId: string,
  provider: string,
  session: string | null,
  now: Date = new Date(),
): BeforeUserWait {
  const drain = repos.db.transaction((): BeforeUserWait => {
    // Spent either way: one deny earns this session one question let through.
    const grantedAt = repos.agentEndpoints.takeUserWaitAllowance(agentId, session);
    if (grantedAt !== undefined && deniedRecently(grantedAt, now)) return NOTHING_TO_SHOW;
    // Listed before claiming, so a message claimed below is not also counted as held.
    const held = repos.agentMessages.listUnreadForSession(agentId, session).map(toDeliverable);
    const claimed = drainInbox(repos, agentId, provider, capabilityFor(provider), {
      session,
      via: 'hook',
    });
    if (held.length > 0 || claimed.length > 0) {
      repos.agentEndpoints.setAwaitingUser(agentId, null);
      repos.agentEndpoints.grantUserWaitAllowance(
        agentId,
        session,
        now.toISOString(),
        new Date(now.getTime() - USER_WAIT_DENY_WINDOW_MS).toISOString(),
      );
    }
    return { held, claimed };
  });
  return drain.immediate();
}
export interface BeforeUserWaitHookOptions {
  /** `--agent`: the inbox to drain; defaults to the session's own identity. */
  agent: string | undefined;
  provider: string;
  /** `--from-hook`: identity may come from the hook payload. */
  fromHook: boolean;
}

/**
 * The `PreToolUse` hook on `AskUserQuestion`: read the session's evidence of
 * what its model has seen, then deny the question with anything unseen, or
 * print nothing so the picker opens.
 */
export async function runBeforeUserWaitHook(
  options: BeforeUserWaitHookOptions,
  telemetry: TelemetryRecorder | undefined,
): Promise<void> {
  const hookPayload = readHookPayload() ?? '';
  const agentId = resolveInboxOwner(options.agent, process.env, {
    kind: options.provider,
    ...(options.fromHook ? { hookPayload } : {}),
  });
  // A subagent shares its parent's session id, so its hooks resolve the
  // parent's agent; its question is no proof of what the parent's model saw (#216).
  if (isSubagentHook(parseObservedHook(hookPayload))) return;
  const context = await import('../context.js').then((module) => module.openContext(process.cwd()));
  // Read evidence first, so this hook never marks read a message it is itself
  // about to deliver.
  observeHookEvent(context.repos, agentId, hookPayload, options.provider);
  const { held, claimed } = drainBeforeUserWait(
    context.repos,
    agentId,
    options.provider,
    currentSession(options.provider, hookPayload),
  );
  // Held messages were counted when the monitor took them.
  recordDeliveredMessages(telemetry, claimed);
  if (held.length > 0 || claimed.length > 0) {
    process.stdout.write(renderHookPayload('pre-tool-use', [...held, ...claimed]));
  }
}
