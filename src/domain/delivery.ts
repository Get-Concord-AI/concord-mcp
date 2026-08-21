/**
 * How a message reaches an agent, and what an agent can be reached *during*.
 *
 * A Concord `agent_id` is the standard identity; `agent_endpoints` is the
 * routing table that says how to get to it. Everything harness-specific lives
 * behind these two closed unions, so adding a client means adding a case the
 * compiler forces you to handle — not a new branch in the send path.
 */

import {
  configuredMonitorCapabilityFor,
  defaultCapabilityFor,
  deliveryCapabilities,
  reaches,
  transports,
  type DeliveryCapability,
  type EndpointCapability,
  type Reach,
  type Transport,
} from './harness-config.js';

export {
  deliveryCapabilities,
  reaches,
  transports,
  type DeliveryCapability,
  type EndpointCapability,
  type Reach,
  type Transport,
};

/**
 * Which states an agent can be reached in.
 *
 * `busy` — a turn is running, so a tool-result hook will be hit.
 * `idle`  — sitting at the prompt with nothing scheduled; only a background
 *           watcher or an external push gets in.
 *
 * Codex hooks are `busy` only: an idle Codex session runs no hook and does not
 * see a queued message until its next turn. Telling the sender that is the
 * difference between "queued" and "silently ignored for an hour".
 */
/** What a given client can do. Unknown clients get the conservative answer. */
export function capabilityFor(provider: string): EndpointCapability {
  return defaultCapabilityFor(provider);
}

/** Capability advertised by a live harness-owned inbox monitor. */
export function monitorCapabilityFor(provider: string): EndpointCapability {
  return configuredMonitorCapabilityFor(provider);
}

/** Serialize a capability for the endpoint row's `capabilities` column. */
export function encodeCapabilities(capability: EndpointCapability): string[] {
  return [...new Set([capability.transport, ...capability.operations, ...capability.reach])];
}

/** Read reach back off a stored endpoint. */
function decodeReach(capabilities: readonly string[]): Reach[] {
  return reaches.filter((reach) => capabilities.includes(reach));
}

/**
 * What to tell the sender about a message that has been accepted but not yet
 * seen. An agent that cannot be reached while idle may sit on it indefinitely,
 * and a sender that believes otherwise will wait on a reply that never comes.
 */
export function deliveryOutlook(capabilities: readonly string[]): string {
  if (capabilities.includes('inject') && capabilities.includes('steer')) {
    return 'It can be injected now, whether working or idle: a busy turn is steered and an idle session starts a turn.';
  }
  return decodeReach(capabilities).includes('idle')
    ? 'It will arrive on its own, whether that agent is working or idle.'
    : 'That agent only checks between steps of its own work, so an idle session ' +
        'will not see this until its next turn.';
}

/** Whether the endpoint should be contacted instead of waiting for a pull. */
export function supportsImmediateDelivery(capabilities: readonly string[]): boolean {
  return capabilities.includes('inject') || capabilities.includes('steer');
}

/** The small part of an endpoint needed to derive honest receive capability. */
export interface ReceiverEndpoint {
  transport: string;
  capabilities: readonly string[];
  status: string;
  expiresAt: string | null;
  receiverExpiresAt: string | null;
}

/** Whether something is presently able to wake this endpoint while it is idle. */
export function receiverActive(endpoint: ReceiverEndpoint | undefined, now = Date.now()): boolean {
  if (
    endpoint?.status !== 'connected' ||
    (!endpoint.capabilities.includes('idle') && !endpoint.capabilities.includes('inject'))
  ) {
    return false;
  }
  if (endpoint.transport !== 'pull') {
    return endpoint.expiresAt === null || Date.parse(endpoint.expiresAt) > now;
  }
  return endpoint.receiverExpiresAt !== null && Date.parse(endpoint.receiverExpiresAt) > now;
}

/** Strip idle-only promises when the process that fulfils them is not alive. */
export function effectiveEndpointCapabilities(
  endpoint: ReceiverEndpoint | undefined,
  now = Date.now(),
): string[] {
  if (endpoint === undefined) return [];
  if (receiverActive(endpoint, now)) return [...endpoint.capabilities];
  return endpoint.capabilities.filter(
    (capability) => capability !== 'idle' && capability !== 'inject',
  );
}
