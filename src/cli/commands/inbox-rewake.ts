import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderMonitorLines, type DeliverableMessage } from '../../domain/pull-inbox.js';

/**
 * Idle wakeup for Claude Code sessions an embedding app drives through the
 * Claude Agent SDK (Conductor, for one).
 *
 * The relay plugin's native monitor wakes an idle interactive session, but the
 * SDK never starts plugin monitors, so an SDK-hosted session would sit on a
 * message until its user typed. Claude Code's `asyncRewake` hooks run in the
 * background and, on exit code 2, wake the model with their stderr even when
 * the session is idle. The plugin arms one at every Stop: it waits for this
 * agent's next message, prints it, and exits 2. Not at SessionStart: an SDK
 * session does not finish starting until its SessionStart hooks exit, async or
 * not, so a waiter there would hold it forever. An SDK host always opens a
 * session with a prompt, so the first Stop follows at once.
 *
 * Each Stop starts a new waiter while the last one may still be waiting, so a
 * waiter records itself as the session's newest and stands down (exit 0,
 * which wakes nothing) as soon as a newer one takes its place.
 */

/** Exit code that makes an `asyncRewake` hook wake the model. */
export const REWAKE_EXIT_CODE = 2;
/** How often a waiter checks whether a newer one has replaced it. */
const SUPERSEDED_CHECK_MS = 1_000;

/**
 * Whether this Claude Code process is hosted by the Agent SDK, where plugin
 * monitors never run. Interactive sessions (`cli`) keep their native monitor,
 * and a second receiver would only race it; `-p` runs (`sdk-cli`) are
 * one-shot, and Claude Code kills their async hooks at teardown.
 */
export function hostsRewake(env: NodeJS.ProcessEnv): boolean {
  const entrypoint = env['CLAUDE_CODE_ENTRYPOINT']?.trim();
  return entrypoint === 'sdk-ts' || entrypoint === 'sdk-py';
}

/**
 * Claude Code shows a rewake as "Stop hook blocking error from command …", so
 * the first line says what actually happened before the framed messages.
 */
export const REWAKE_HEADER =
  'Not an error: Concord delivered a message from another agent while this session was idle.';

/** What a waking turn shows the model: a header, then one framed line per message. */
export function renderRewake(messages: readonly DeliverableMessage[]): string {
  return `${[REWAKE_HEADER, ...renderMonitorLines(messages)].join('\n')}\n`;
}

function claimPath(agentId: string, dir: string): string {
  const key = createHash('sha256').update(agentId).digest('hex').slice(0, 16);
  return join(dir, `${key}.waiter`);
}

function readClaim(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

export interface WaiterClaim {
  /** Whether a newer waiter has taken this agent's place since this one began. */
  superseded(): boolean;
  /** Gives up the claim, if it is still this waiter's. */
  release(): void;
}

/**
 * Records this waiter as `agentId`'s newest. A token rather than a pid, so a
 * recycled pid can never be mistaken for a live waiter, and no waiter ever
 * signals a process it did not start.
 */
export function claimWaiter(
  agentId: string,
  token: string,
  dir: string = join(tmpdir(), 'concord-rewake'),
): WaiterClaim {
  mkdirSync(dir, { recursive: true });
  const path = claimPath(agentId, dir);
  writeFileSync(path, token);
  return {
    superseded: () => readClaim(path) !== token,
    release: () => {
      if (readClaim(path) === token) rmSync(path, { force: true });
    },
  };
}

/**
 * Stops the watch, through the same signal path a harness uses, once a newer
 * waiter has claimed the agent. Returns the timer's cancel.
 */
export function standDownWhenSuperseded(claim: WaiterClaim, stop: () => void): () => void {
  const timer = setInterval(() => {
    if (claim.superseded()) stop();
  }, SUPERSEDED_CHECK_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
