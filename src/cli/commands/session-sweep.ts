import type { Repositories } from '../../db/index.js';
import { renderPeerMessage } from '../../domain/pull-inbox.js';
import type { PushPromptSession } from '../../relay/adapters.js';
import { RELAY_PROTOCOL_VERSION } from '../../relay/protocol.js';
import type { AgentSessionAdapter, AgentSessionDelivery } from '../../relay/server.js';

/**
 * Hands relay deliveries to a harness session that takes pushed prompts. A
 * sender's dispatcher has already framed each one with its sender and id, as
 * hooks and the cloud host do, so the harness can tell a peer message from the
 * user and knows which id to answer; framing it again here would show the
 * header twice.
 */
export class TrackedSessionAdapter implements AgentSessionAdapter {
  /** Every message handed to the session, so a sweep never hands one over twice. */
  readonly handled = new Set<string>();

  constructor(
    readonly provider: string,
    private readonly session: PushPromptSession,
  ) {}

  isBusy(): boolean {
    return this.session.isBusy();
  }

  steer(delivery: AgentSessionDelivery): Promise<string | undefined> {
    this.handled.add(delivery.messageId);
    return this.session.pushPrompt(delivery.content, 'steer');
  }

  inject(delivery: AgentSessionDelivery): Promise<string | undefined> {
    this.handled.add(delivery.messageId);
    return this.session.pushPrompt(delivery.content, 'inject');
  }
}

/** How old a pending message must be before the sweep takes it: past any push. */
export const SWEEP_AFTER_MS = 10_000;
const SWEEP_EVERY_MS = 5_000;

/**
 * The live host is its session's single consumer: hooks of a hosted session do
 * not drain. A sender keeps a message pending while it pushes it here, and
 * leaves it pending when the push fails or times out — even if the push reached
 * the harness late. The sweep takes messages pending past that window: one this
 * host already handed over is only marked delivered; any other is handed over
 * and marked delivered once the harness accepts it. A failed handoff stays
 * pending for the next sweep, or for the hooks once this host is gone — nothing
 * is claimed that has not reached the session.
 */
export async function sweepStragglers(
  repos: Repositories,
  agentId: string,
  adapter: TrackedSessionAdapter,
  now = Date.now(),
): Promise<void> {
  const cutoff = new Date(now - SWEEP_AFTER_MS).toISOString();
  const stragglers = repos.agentMessages
    .listPendingForRecipient(agentId)
    .filter((message) => message.createdAt < cutoff);
  for (const message of stragglers) {
    if (adapter.handled.has(message.messageId)) {
      repos.agentMessages.markDelivered(message.messageId, adapter.provider, null);
      continue;
    }
    const delivery: AgentSessionDelivery = {
      version: RELAY_PROTOCOL_VERSION,
      type: 'deliver',
      messageId: message.messageId,
      senderAgentId: message.senderAgentId,
      recipientAgentId: agentId,
      // Read straight from the store, so framed here as a dispatcher would.
      content: renderPeerMessage(message),
    };
    let receipt: string | undefined;
    try {
      receipt = await (adapter.isBusy() ? adapter.steer(delivery) : adapter.inject(delivery));
    } catch {
      // Not handed over: still pending, so the next sweep tries again.
      adapter.handled.delete(message.messageId);
      continue;
    }
    // Handed over: it stays in `handled`, so if recording this fails the next
    // sweep only retries the record, never the handoff.
    repos.agentMessages.markDelivered(message.messageId, adapter.provider, receipt ?? null);
  }
}

/** Run the sweep on a timer, one at a time; returns a function that stops it. */
export function startSweeper(
  repos: Repositories,
  agentId: string,
  adapter: TrackedSessionAdapter,
): () => void {
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweepStragglers(repos, agentId, adapter)
      .catch(() => undefined)
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_EVERY_MS);
  return () => {
    clearInterval(timer);
  };
}
