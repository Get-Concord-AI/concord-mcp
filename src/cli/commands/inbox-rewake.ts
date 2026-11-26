import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { userConcordDir } from '../../config/user-config.js';
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
 * Whether an `inbox rewake` invocation should keep waiting for a message once
 * it has proven it runs inside a real hook. SDK hosts have no plugin monitor,
 * so they always wait; interactive sessions wait only when no receiver is
 * beating — the monitor that should do it failed to (re)arm, the gap #180
 * tracks after a `/resume`. `-p` one-shot runs never wait: Claude Code kills
 * their async hooks at teardown, and `receiverAlive` is only consulted for
 * interactive sessions, so callers pass `undefined` for SDK hosts.
 */
export function rewakeWaits(env: NodeJS.ProcessEnv, receiverAlive: boolean | undefined): boolean {
  if (env['CLAUDE_CODE_ENTRYPOINT']?.trim() === 'sdk-cli') return false;
  if (hostsRewake(env)) return true;
  return receiverAlive !== true;
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

/**
 * Where waiter claims live. Under the user Concord dir rather than the shared
 * temp dir: the file name is a predictable hash of the agent id, and a shared
 * directory would let another local account plant a symlink there.
 */
export function defaultWaiterDir(env: NodeJS.ProcessEnv): string {
  return join(userConcordDir(env), 'concord-rewake');
}

function readClaim(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** How long a waiter waits for the claim lock between tries. */
const LOCK_SPIN_MS = 5;
/**
 * A lock this old is a dead process's: every critical section is synchronous
 * and microseconds long, so a live holder never yields while it keeps one.
 */
const LOCK_STALE_MS = 2_000;
/**
 * How long a waiter spins before proceeding without the lock. Unreachable in
 * practice — a stale lock is broken within LOCK_STALE_MS — but a hook must
 * never hang: running unlocked degrades to the pre-lock behaviour, it never
 * blocks delivery.
 */
const LOCK_WAIT_MS = 10_000;

/**
 * Runs `work` holding the per-claim lock, so a claim write and a release can
 * never interleave. Without serialization an exiting waiter's compare-and-delete
 * can move a newer claim aside — however briefly — and the newer waiter reads
 * the missing file as its own supersession: both waiters stop, nobody watches.
 * The lock is an exclusive-create file; spinning is synchronous because every
 * critical section is, so a live holder never keeps it longer than microseconds.
 */
function withClaimLock<T>(path: string, work: () => T): T {
  const lockPath = `${path}.lock`;
  const started = Date.now();
  let acquired = false;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      acquired = true;
      break;
    } catch {
      // Held by another process, or the filesystem refused — retry either way.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
        }
      } catch {
        // Already released: the next create succeeds.
      }
      if (Date.now() - started > LOCK_WAIT_MS) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_SPIN_MS);
    }
  }
  try {
    return work();
  } finally {
    if (acquired) rmSync(lockPath, { force: true });
  }
}

export interface WaiterClaim {
  /** Whether a newer waiter has taken this agent's place since this one began. */
  readonly superseded: () => boolean;
  /** Gives up the claim, if it is still this waiter's. */
  readonly release: () => void;
}

/**
 * Records this waiter as `agentId`'s newest. A token rather than a pid, so a
 * recycled pid can never be mistaken for a live waiter, and no waiter ever
 * signals a process it did not start.
 */
export function claimWaiter(
  agentId: string,
  token: string,
  dir: string = defaultWaiterDir(process.env),
): WaiterClaim {
  mkdirSync(dir, { recursive: true });
  const path = claimPath(agentId, dir);
  withClaimLock(path, () => {
    try {
      // Never write through a planted symlink: drop the link itself and claim
      // the name fresh. readClaim/release only ever remove the link, never its
      // target.
      if (lstatSync(path).isSymbolicLink()) rmSync(path);
    } catch {
      // Absent or unreadable: writeFileSync below reports the real failure.
    }
    writeFileSync(path, token);
  });
  return {
    superseded: () => {
      const current = readClaim(path);
      if (current === token) return false;
      if (current !== undefined) return true;
      // A missing file is not proof on its own: a writer paused mid-write or
      // a release in flight can leave the path empty for moments, and a newer
      // waiter checking inside that window would otherwise stand down
      // alongside the older one — both gone, nobody watching. Only an absence
      // outliving that window means the claim is really gone.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      return readClaim(path) !== token;
    },
    release: () => {
      withClaimLock(path, () => {
        // Compare-and-delete, serialized: every writer holds this lock, so a
        // token match here is still this waiter's claim when it is removed —
        // a newer waiter's claim can never be moved aside, not even briefly.
        if (readClaim(path) !== token) return;
        rmSync(path, { force: true });
      });
    },
  };
}

/**
 * Stands down the waiter `agentId` has armed, if there is one: a fresh claim
 * the waiter does not hold supersedes it, and it stops within a second. A
 * no-op when nothing is armed — a SessionEnd hook fires in every repository
 * once the plugin is installed, and one that has nothing to do with Concord
 * must not have the waiter directory created for it.
 */
export function supersedeWaiter(
  agentId: string,
  dir: string = defaultWaiterDir(process.env),
): void {
  if (!existsSync(claimPath(agentId, dir))) return;
  claimWaiter(agentId, randomUUID(), dir).release();
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
