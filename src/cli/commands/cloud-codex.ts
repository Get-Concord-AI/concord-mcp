import { readAgentState, reportDeliveryFailure, type CloudRuntime } from '../../cloud/runtime.js';
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

/**
 * Hands drained messages to the session, one at a time. A message the session
 * would not take is recorded as failed in the cloud, so its sender sees that
 * rather than taking silence for delivery.
 */
export async function deliverToSession(
  runtime: CloudRuntime,
  agentKey: string,
  adapter: AgentSessionAdapter,
  messages: readonly DeliverableMessage[],
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
    try {
      if (adapter.isBusy()) await adapter.steer(delivery);
      else await adapter.inject(delivery);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Concord: could not hand ${message.messageId} to Codex: ${detail}\n`);
      const agent = readAgentState(runtime, agentKey);
      if (agent !== undefined) {
        await reportDeliveryFailure(runtime, agent, message.messageId, detail).catch(
          () => undefined,
        );
      }
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
    await watchCloud(runtime, agentKey, 'codex', false, (messages) =>
      deliverToSession(runtime, agentKey, adapter, messages),
    );
  } finally {
    client.close();
  }
}
