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
import { monitorInstanceId } from '../live-identity.js';
import { claimWaiter, standDownWhenSuperseded } from './inbox-rewake.js';
import { heartbeatReceiver, isSqliteBusy, registerPullEndpoint } from './inbox.js';

const KIND = 'openclaw';
const POLL_MS = 1_000;
const HEALTH_MS = 15_000;
/** OpenClaw settings that select a separate profile, state directory or Gateway. */
const GATEWAY_ENV = [
  'OPENCLAW_PROFILE',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_GATEWAY_URL',
  'OPENCLAW_GATEWAY_PORT',
] as const;
const agentSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/u, 'Use an OpenClaw agent ID such as main.');

export async function deliverOpenclawInbox(
  repos: Repositories,
  agentId: string,
  adapter: OpenclawSessionAdapter,
  stop: AbortSignal,
  receiverOwner: string,
): Promise<void> {
  registerPullEndpoint(repos, agentId, KIND, Date.now(), monitorCapabilityFor(KIND));
  heartbeatReceiver(repos, agentId, POLL_MS, receiverOwner);
  repos.agents.heartbeat(agentId);
  repos.agentMessages.sweepStale();
  for (const message of repos.agentMessages.listPendingForRecipient(agentId)) {
    if (stop.aborted) return;
    heartbeatReceiver(repos, agentId, POLL_MS, receiverOwner);
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

/**
 * The receiver's claim key: one receiver per agent, Concord workspace and
 * OpenClaw profile. A receiver for the same agent ID in another project or
 * profile watches a different inbox and Gateway, so it must not stand this
 * one down.
 */
export function receiverClaimKey(agentId: string, scope: string, env: NodeJS.ProcessEnv): string {
  const gateway = GATEWAY_ENV.map((name) => `${name}=${env[name]?.trim() ?? ''}`);
  return [agentId, scope, ...gateway].join('\0');
}

async function watchLocal(
  repos: Repositories,
  agentId: string,
  adapter: OpenclawSessionAdapter,
  stop: AbortSignal,
  superseded: () => boolean,
  receiverOwner: string,
): Promise<void> {
  try {
    while (!stop.aborted) {
      try {
        await deliverOpenclawInbox(repos, agentId, adapter, stop, receiverOwner);
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
      }
      await delay(POLL_MS, undefined, { signal: stop }).catch(() => undefined);
    }
  } finally {
    const endpoint = repos.agentEndpoints.getByAgent(agentId);
    if (endpoint !== undefined && !superseded())
      repos.agentEndpoints.clearReceiver(endpoint.endpointId, receiverOwner);
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
  const context =
    access.kind === 'cloud'
      ? undefined
      : await import('../context.js').then((module) => module.openContext(cwd));
  const scope =
    access.kind === 'cloud'
      ? `cloud:${access.runtime.apiUrl}:${access.runtime.projectKey}`
      : `local:${context?.workspaceId ?? ''}`;
  const stop = new AbortController();
  const stopWatching = (): void => {
    stop.abort();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const claim = claimWaiter(receiverClaimKey(agentId, scope, env), randomUUID());
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
    process.stdout.write(`Receiving live Concord messages for ${agentId}.\n`);
    if (access.kind === 'cloud') {
      const adapter = new OpenclawSessionAdapter(agent, undefined, call);
      await watchCloud(
        access.runtime,
        agentId,
        KIND,
        false,
        (messages, signal) => deliverToSession(access.runtime, agentId, adapter, messages, signal),
        { replaced: claim.superseded, signal: stop.signal },
      );
      return;
    }
    if (context === undefined) return;
    const adapter = new OpenclawSessionAdapter(agent, context.workspaceId, call);
    await watchLocal(
      context.repos,
      agentId,
      adapter,
      stop.signal,
      claim.superseded,
      monitorInstanceId(env),
    );
  } finally {
    clearInterval(health);
    cancel();
    claim.release();
    for (const signal of signals) process.off(signal, stopWatching);
    context?.repos.db.close();
  }
}
