import { setTimeout as delay } from 'node:timers/promises';

import {
  before,
  CloudApiError,
  readAgentState,
  reportDeliveryFailure,
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

/** How long Codex may take to accept one message before it counts as not taken. */
const HANDOFF_TIMEOUT_MS = 30_000;
/** Pauses between attempts to record a failure, so a brief outage does not lose it. */
const REPORT_RETRY_DELAYS_MS = [0, 2_000, 5_000];

/**
 * Records that a message was not taken, retrying a few times: the batch was
 * drained, so this report is the sender's only way to learn it was not
 * delivered.
 */
async function reportFailure(
  runtime: CloudRuntime,
  agentKey: string,
  messageId: string,
  detail: string,
): Promise<void> {
  const agent = readAgentState(runtime, agentKey);
  if (agent === undefined) return;
  for (const pause of REPORT_RETRY_DELAYS_MS) {
    await delay(pause);
    try {
      await reportDeliveryFailure(runtime, agent, messageId, detail);
      return;
    } catch (error) {
      if (error instanceof CloudApiError && error.status < 500 && error.status !== 429) return;
    }
  }
  process.stderr.write(`Concord: could not record that ${messageId} was not delivered.\n`);
}

/**
 * Hands drained messages to the session, one at a time. A message the session
 * would not take — refused, or not answered within the handoff timeout — is
 * recorded as failed in the cloud, so its sender sees that rather than taking
 * silence for delivery. Stopping the host ends a handoff in progress.
 */
export async function deliverToSession(
  runtime: CloudRuntime,
  agentKey: string,
  adapter: AgentSessionAdapter,
  messages: readonly DeliverableMessage[],
  stop?: AbortSignal,
  handoffTimeoutMs = HANDOFF_TIMEOUT_MS,
): Promise<void> {
  for (const message of messages) {
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
    const timeout = AbortSignal.timeout(handoffTimeoutMs);
    const bound = stop === undefined ? timeout : AbortSignal.any([timeout, stop]);
    try {
      await before(adapter.isBusy() ? adapter.steer(delivery) : adapter.inject(delivery), bound);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Concord: could not hand ${message.messageId} to Codex: ${detail}\n`);
      await reportFailure(runtime, agentKey, message.messageId, detail);
    }
  }
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
