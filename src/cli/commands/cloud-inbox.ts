import { setTimeout as delay } from 'node:timers/promises';

import { cloudSessionFor } from '../../cloud/proxy.js';
import {
  asCloudAgent,
  CloudApiError,
  connectPullEndpoint,
  drainCloud,
  MAX_WAIT_SECONDS,
  readAgentState,
  releaseReceiver,
  renewReceiver,
  takeDrainKey,
  toDeliverables,
  updateAgentState,
  type CloudAgentRef,
  type CloudRuntime,
} from '../../cloud/runtime.js';
import { readLink } from '../../cloud/settings.js';
import { resolveCheckoutRoot, resolveRepoRoot } from '../../config/paths.js';
import { capabilityFor, encodeCapabilities, monitorCapabilityFor } from '../../domain/delivery.js';
import type { DeliverableMessage } from '../../domain/pull-inbox.js';

/**
 * The inbox commands, in a repository linked to Concord Cloud: the same output,
 * from the cloud instead of `.concord/concord.db`.
 *
 * None of this records telemetry: these are not local operations, and the
 * cloud records its own usage.
 */

/** Whether this directory's repository is linked to Concord Cloud. */
export function cloudLinked(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return readLink(resolveRepoRoot(cwd, env)) !== undefined;
  } catch {
    return false;
  }
}

/** Where a command's work lives: locally, in the cloud, or in a link this machine cannot use. */
export type CloudAccess =
  | { readonly kind: 'local' }
  | { readonly kind: 'cloud'; readonly runtime: CloudRuntime }
  | { readonly kind: 'unusable'; readonly reason: string };

/**
 * A hook runs inside the harness's own time limit (Cursor allows 15 s, Grok
 * 5 s), so all its requests, retries included, are over within this.
 */
export const HOOK_TIMEOUT_MS = 4_000;

export function cloudAccess(
  cwd: string,
  options: { readonly timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): CloudAccess {
  if (!cloudLinked(cwd, env)) return { kind: 'local' };
  try {
    // The checkout this command runs in, which in a linked worktree is not the
    // primary one holding the link: paths are made relative to it.
    const session = cloudSessionFor(
      resolveRepoRoot(cwd, env),
      env,
      undefined,
      resolveCheckoutRoot(cwd, env),
    );
    if (session === undefined) return { kind: 'local' };
    const deadline =
      options.timeoutMs === undefined ? {} : { deadline: Date.now() + options.timeoutMs };
    return { kind: 'cloud', runtime: { ...session, fetch, ...deadline } };
  } catch (error) {
    // Linked, but not logged in, or logged in elsewhere: say so, never fall
    // back to a local inbox no other agent would see.
    return { kind: 'unusable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** How long the receiver lease lasts; renewed well within it each round. */
const RECEIVER_TTL_SECONDS = 90;
/** Pause after a failed round, so an outage is not met with a request storm. */
const RETRY_DELAY_MS = 5_000;

/** Whether a running `inbox watch` on this machine holds the agent's receiver. */
export function watching(runtime: CloudRuntime, agentKey: string): boolean {
  return (readAgentState(runtime, agentKey)?.watchingUntil ?? 0) > Date.now();
}

/**
 * Advertises the session as able to drain its messages. A running monitor's
 * idle reach is kept: advertising less would make the agent look unreachable
 * while it waits, and re-registering clears the cloud's receiver lease, so the
 * lease is taken again on the monitor's behalf.
 */
async function advertise(
  runtime: CloudRuntime,
  agent: CloudAgentRef,
  agentKey: string,
  provider: string,
  asMonitor: boolean,
): Promise<void> {
  const monitor = asMonitor || watching(runtime, agentKey);
  const capability = monitor ? monitorCapabilityFor(provider) : capabilityFor(provider);
  await connectPullEndpoint(runtime, agent, agentKey, provider, encodeCapabilities(capability));
  if (monitor && !asMonitor) await renewReceiver(runtime, agent, RECEIVER_TTL_SECONDS);
}

/**
 * Registers the session (from the cached ids when known) and advertises its
 * endpoint. A fresh registration advertises before its ids are kept, so one
 * that could not be advertised is registered again next time.
 */
export function registerInCloud(
  runtime: CloudRuntime,
  agentKey: string,
  provider: string,
  cwd: string,
  asMonitor = false,
): Promise<CloudAgentRef> {
  let advertised = false;
  const advertiseOnce = async (agent: CloudAgentRef): Promise<void> => {
    await advertise(runtime, agent, agentKey, provider, asMonitor);
    advertised = true;
  };
  return asCloudAgent(
    runtime,
    { agentKey, kind: provider, cwd },
    async (agent) => {
      if (!advertised) await advertiseOnce(agent);
      return agent;
    },
    advertiseOnce,
  );
}

/** A failure worth repeating: the network, a timeout, or the cloud briefly unwell. */
function transient(error: Error): boolean {
  if (error instanceof CloudApiError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError || error.name === 'TimeoutError';
}

/**
 * Drains once, under a key held until the answer arrives: a drain whose answer
 * was lost — to the network, a timeout, or the process ending — is retried
 * with its key, now or by a later drain, and the cloud replays its batch.
 */
async function drainOnce(
  runtime: CloudRuntime,
  agent: CloudAgentRef,
  agentKey: string,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<DeliverableMessage[]> {
  const ticket = takeDrainKey(runtime, agentKey);
  let messages: Awaited<ReturnType<typeof drainCloud>>;
  try {
    // A replayed key answers at once, so it never waits.
    messages = await drainCloud(
      runtime,
      agent,
      ticket.key,
      ticket.replay ? 0 : waitSeconds,
      signal,
    );
  } catch (error) {
    if (signal?.aborted === true || !(error instanceof Error) || !transient(error)) throw error;
    messages = await drainCloud(runtime, agent, ticket.key, 0, signal);
  }
  ticket.finish();
  return toDeliverables(messages);
}

/** Takes every message waiting for the session, as a hook does after a tool call. */
export function drainFromCloud(
  runtime: CloudRuntime,
  agentKey: string,
  provider: string,
): Promise<DeliverableMessage[]> {
  return asCloudAgent(
    runtime,
    { agentKey, kind: provider },
    (agent) => drainOnce(runtime, agent, agentKey, 0),
    // Registered here because session start could not: advertise it too, as
    // every local drain does.
    (agent) => advertise(runtime, agent, agentKey, provider, false),
  );
}

/**
 * The session's live receiver: long-polls the cloud, so a message arrives
 * within moments rather than on the next two-second poll. Each round renews
 * the receiver lease and waits on one drain. Stops on SIGINT, SIGTERM or
 * SIGHUP, after the first batch with `once`, or on a failure retrying cannot
 * fix (a lapsed login); releases the lease either way.
 */
export async function watchCloud(
  runtime: CloudRuntime,
  agentKey: string,
  provider: string,
  once: boolean,
  /** Awaited before the next round, so a slow handoff never overlaps the next batch. */
  emit: (messages: readonly DeliverableMessage[]) => Promise<void> | void,
): Promise<void> {
  const stop = new AbortController();
  const stopped = (): boolean => stop.signal.aborted;
  const stopWatching = (): void => {
    stop.abort();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const name of signals) process.once(name, stopWatching);
  let agent: CloudAgentRef | undefined;
  try {
    while (!stopped()) {
      try {
        agent ??= await registerInCloud(runtime, agentKey, provider, process.cwd(), true);
        await renewReceiver(runtime, agent, RECEIVER_TTL_SECONDS);
        updateAgentState(runtime, agentKey, {
          watchingUntil: Date.now() + RECEIVER_TTL_SECONDS * 1000,
        });
        const messages = await drainOnce(runtime, agent, agentKey, MAX_WAIT_SECONDS, stop.signal);
        if (messages.length > 0) await emit(messages);
        if (once && messages.length > 0) return;
      } catch (error) {
        if (stopped()) return;
        if (!(error instanceof Error) || !transient(error)) throw error;
        await delay(RETRY_DELAY_MS, undefined, { signal: stop.signal }).catch(() => undefined);
      }
    }
  } finally {
    for (const name of signals) process.off(name, stopWatching);
    updateAgentState(runtime, agentKey, { watchingUntil: undefined });
    if (agent !== undefined) await releaseReceiver(runtime, agent).catch(() => undefined);
  }
}
