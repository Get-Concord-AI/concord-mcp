import {
  before,
  CloudApiError,
  readAgentState,
  reportDeliveryFailure,
  updateAgentState,
  type CloudRuntime,
} from '../../cloud/runtime.js';
import { renderInboxBody, type DeliverableMessage } from '../../domain/pull-inbox.js';
import { CodexAppServerAdapter } from '../../relay/adapters.js';
import { CodexDaemonClient } from '../../relay/codex-client.js';
import { RELAY_PROTOCOL_VERSION } from '../../relay/protocol.js';
import type { AgentSessionAdapter, AgentSessionDelivery } from '../../relay/server.js';
import { watchCloud } from './cloud-inbox.js';

/**
 * Codex, live, in a repository linked to Concord Cloud. The cloud cannot dial
 * this machine, so the local host that already steers Codex through its
 * app-server pulls instead: it holds the session's receiver and long-polls the
 * cloud, and hands each message to Codex as it arrives — steering a turn under
 * way, or starting one when Codex is idle — as the local relay does.
 */

interface Undelivered {
  readonly messageId: string;
  readonly detail: string;
}

/**
 * Tells the cloud these messages were not delivered, so their senders do not
 * take silence for delivery. The batch was drained, so a report that cannot be
 * made now is kept with the agent's state and made on a later round.
 */
async function reportUndelivered(
  runtime: CloudRuntime,
  agentKey: string,
  failures: readonly Undelivered[],
): Promise<void> {
  const state = readAgentState(runtime, agentKey);
  if (state === undefined) return;
  const pending = [...(state.unreported ?? []), ...failures];
  const kept: Undelivered[] = [];
  for (const failure of pending) {
    try {
      await reportDeliveryFailure(runtime, state, failure.messageId, failure.detail);
    } catch (error) {
      // Refused for good (the message moved on): nothing a retry would change.
      const lasting = error instanceof CloudApiError && error.status < 500 && error.status !== 429;
      if (!lasting) kept.push(failure);
    }
  }
  updateAgentState(runtime, agentKey, { unreported: kept.length === 0 ? undefined : kept });
}

/**
 * Hands drained messages to the session, one at a time and never two at once.
 * A handoff has no time limit: a wedged session stalls the host, which then
 * drains nothing more and lets its receiver lease lapse, so later messages
 * wait for the session's hooks instead. Stopping the host ends a handoff in
 * progress and hands over nothing more. Every message not handed over — or
 * whose handoff ended unconfirmed — is reported as not delivered.
 */
export async function deliverToSession(
  runtime: CloudRuntime,
  agentKey: string,
  adapter: AgentSessionAdapter,
  messages: readonly DeliverableMessage[],
  stop?: AbortSignal,
): Promise<void> {
  const failures: Undelivered[] = [];
  const stopped = (): boolean => stop?.aborted === true;
  for (const message of messages) {
    if (stopped()) {
      failures.push({
        messageId: message.messageId,
        detail: 'The Codex host stopped before handing it over.',
      });
      continue;
    }
    const delivery: AgentSessionDelivery = {
      version: RELAY_PROTOCOL_VERSION,
      type: 'deliver',
      messageId: message.messageId,
      senderAgentId: message.senderAgentId,
      recipientAgentId: agentKey,
      // Framed as every other channel frames it, so the session knows who
      // wrote and which id to answer.
      content: renderInboxBody([message]),
    };
    const handoff = adapter.isBusy() ? adapter.steer(delivery) : adapter.inject(delivery);
    try {
      await (stop === undefined ? handoff : before(handoff, stop));
    } catch (error) {
      const detail = stopped()
        ? 'The Codex host stopped before Codex confirmed it; it may not have arrived.'
        : error instanceof Error
          ? error.message
          : String(error);
      process.stderr.write(`Concord: could not hand ${message.messageId} to Codex: ${detail}\n`);
      failures.push({ messageId: message.messageId, detail });
    }
  }
  await reportUndelivered(runtime, agentKey, failures);
}

/** Hosts one Codex thread's live receiver against the cloud, until stopped. */
export async function hostCodexInCloud(
  runtime: CloudRuntime,
  agentKey: string,
  threadId: string,
): Promise<void> {
  const client = new CodexDaemonClient();
  await client.connect();
  await client.resumeThread(threadId);
  const adapter = new CodexAppServerAdapter(client, threadId, () => client.currentTurnId());
  try {
    await watchCloud(runtime, agentKey, 'codex', false, (messages, stop) =>
      deliverToSession(runtime, agentKey, adapter, messages, stop),
    );
  } finally {
    client.close();
  }
}
