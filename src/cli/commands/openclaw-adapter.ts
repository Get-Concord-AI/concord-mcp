import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import type { Repositories } from '../../db/index.js';
import { monitorCapabilityFor } from '../../domain/delivery.js';
import { executablePath } from '../../install/adapters/probe.js';
import { listOpenclawAgents } from '../../install/openclaw-workspaces.js';
import { openclawGateway, OpenclawSessionAdapter } from '../../relay/openclaw-gateway.js';
import { RELAY_PROTOCOL_VERSION } from '../../relay/protocol.js';
import { deliverToSession } from './cloud-codex.js';
import { cloudAccess, watchCloud } from './cloud-inbox.js';
import { claimWaiter, standDownWhenSuperseded } from './inbox-rewake.js';
import { heartbeatReceiver, isSqliteBusy, registerPullEndpoint } from './inbox.js';

const KIND = 'openclaw';
const POLL_MS = 1_000;
const HEALTH_MS = 15_000;
const agentSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/u, 'Use an OpenClaw agent ID such as main.');

export async function deliverOpenclawInbox(
  repos: Repositories,
  agentId: string,
  adapter: OpenclawSessionAdapter,
  stop: AbortSignal,
): Promise<void> {
  registerPullEndpoint(repos, agentId, KIND, Date.now(), monitorCapabilityFor(KIND));
  heartbeatReceiver(repos, agentId, POLL_MS);
  repos.agents.heartbeat(agentId);
  repos.agentMessages.sweepStale();
  for (const message of repos.agentMessages.listPendingForRecipient(agentId)) {
    if (stop.aborted) return;
    heartbeatReceiver(repos, agentId, POLL_MS);
    const runId = await adapter.inject({
      version: RELAY_PROTOCOL_VERSION,
      type: 'deliver',
      messageId: message.messageId,
      senderAgentId: message.senderAgentId,
      recipientAgentId: agentId,
      content: message.content,
    });
    repos.agentMessages.markDelivered(message.messageId, KIND, runId, { via: 'adapter' });
  }
}

async function watchLocal(
  repos: Repositories,
  agentId: string,
  adapter: OpenclawSessionAdapter,
  stop: AbortSignal,
  superseded: () => boolean,
): Promise<void> {
  try {
    while (!stop.aborted) {
      try {
        await deliverOpenclawInbox(repos, agentId, adapter, stop);
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
      }
      await delay(POLL_MS, undefined, { signal: stop }).catch(() => undefined);
    }
  } finally {
    const endpoint = repos.agentEndpoints.getByAgent(agentId);
    if (endpoint !== undefined && !superseded())
      repos.agentEndpoints.clearReceiver(endpoint.endpointId);
  }
}

/** Run one receiver beside the user's Gateway, without starting a second Gateway. */
export async function launchOpenclaw(rawAgent: string, cwd: string = process.cwd()): Promise<void> {
  const agent = agentSchema.parse(rawAgent);
  const env = process.env;
  const executable = executablePath(KIND, env);
  if (executable === undefined) throw new Error('OpenClaw was not found on PATH.');
  if (!listOpenclawAgents(executable, env).some(({ id }) => id === agent)) {
    throw new Error(`OpenClaw agent "${agent}" was not found. See openclaw agents list.`);
  }
  const access = cloudAccess(cwd);
  if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
  const call = openclawGateway(executable, env);
  await call('health');

  const agentId = `openclaw:${agent}`;
  const stop = new AbortController();
  const stopWatching = (): void => {
    stop.abort();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const claim = claimWaiter(agentId, randomUUID());
  const cancel = standDownWhenSuperseded(claim, stopWatching);
  for (const signal of signals) process.once(signal, stopWatching);
  let checking = false;
  const health = setInterval(() => {
    if (checking) return;
    checking = true;
    void call('health')
      .catch(() => {
        process.stderr.write(
          'Concord: OpenClaw Gateway is unavailable. Restart the receiver once it is up.\n',
        );
        stopWatching();
      })
      .finally(() => {
        checking = false;
      });
  }, HEALTH_MS);
  health.unref();

  try {
    if (access.kind === 'cloud') {
      const adapter = new OpenclawSessionAdapter(agent, undefined, call);
      process.stdout.write(`Receiving live Concord messages for ${agentId}.\n`);
      await watchCloud(
        access.runtime,
        agentId,
        KIND,
        false,
        (messages, signal) => deliverToSession(access.runtime, agentId, adapter, messages, signal),
        claim.superseded,
        stop.signal,
      );
      return;
    }
    const { openContext } = await import('../context.js');
    const context = openContext(cwd);
    try {
      const adapter = new OpenclawSessionAdapter(agent, context.workspaceId, call);
      process.stdout.write(`Receiving live Concord messages for ${agentId}.\n`);
      await watchLocal(context.repos, agentId, adapter, stop.signal, claim.superseded);
    } finally {
      context.repos.db.close();
    }
  } finally {
    clearInterval(health);
    cancel();
    claim.release();
    for (const signal of signals) process.off(signal, stopWatching);
  }
}
