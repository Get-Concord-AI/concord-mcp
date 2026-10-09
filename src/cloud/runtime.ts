import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { DeliverableMessage } from '../domain/pull-inbox.js';
import { VERSION } from '../version.js';
import type { Fetch } from './client.js';
import type { CloudSession } from './proxy.js';

/**
 * A session's runtime against Concord Cloud: what the inbox commands and the
 * session-start hook do locally over SQLite, done over the cloud's REST API.
 *
 * Agents are named by the runtime's own key; the cloud's ids for this machine
 * and its agents are kept in `.concord/cloud-agents.json`, so a hook that runs
 * after every tool call costs one request rather than four. A cached id the
 * cloud no longer knows is registered again and the call retried once.
 */

export type CloudRuntime = Pick<CloudSession, 'apiUrl' | 'bearer' | 'machineKey' | 'repoRoot'> & {
  readonly fetch: Fetch;
};

/** A drain waits at most this long; the cloud allows 25 seconds. */
export const MAX_WAIT_SECONDS = 25;
/** A cold Cloud Run start is the slow case; a long-poll adds its wait. */
const TIMEOUT_MS = 15_000;

/** An answer the cloud gave that was not a success. */
export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(
  runtime: CloudRuntime,
  method: string,
  path: string,
  schema: z.ZodType<T>,
  body?: object,
  waitSeconds = 0,
): Promise<T> {
  const response = await runtime.fetch(`${runtime.apiUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await runtime.bearer()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS + waitSeconds * 1000),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new CloudApiError(
      response.status,
      `Concord Cloud answered ${String(response.status)} to ${method} ${path}: ${detail}`,
    );
  }
  if (response.status === 204) return schema.parse({});
  const raw: unknown = await response.json();
  return schema.parse(raw);
}

const withId = z.object({ id: z.string() });
const empty = z.object({});

const cachedAgent = z.object({ agentId: z.string(), machineId: z.string() });
export type CloudAgentRef = z.infer<typeof cachedAgent>;

const cacheSchema = z.object({
  apiUrl: z.string(),
  machineKey: z.string(),
  agents: z.record(z.string(), cachedAgent),
});
type Cache = z.infer<typeof cacheSchema>;

export function agentCachePath(repoRoot: string): string {
  return join(repoRoot, '.concord', 'cloud-agents.json');
}

/** The cache for this API and machine; anything else is someone else's ids. */
function readCache(runtime: CloudRuntime): Cache {
  const fresh: Cache = { apiUrl: runtime.apiUrl, machineKey: runtime.machineKey, agents: {} };
  try {
    const raw: unknown = JSON.parse(readFileSync(agentCachePath(runtime.repoRoot), 'utf8'));
    const parsed = cacheSchema.safeParse(raw);
    return parsed.success &&
      parsed.data.apiUrl === runtime.apiUrl &&
      parsed.data.machineKey === runtime.machineKey
      ? parsed.data
      : fresh;
  } catch {
    return fresh;
  }
}

function writeCache(runtime: CloudRuntime, cache: Cache): void {
  const path = agentCachePath(runtime.repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`);
  renameSync(temp, path);
}

export interface AgentRegistration {
  readonly agentKey: string;
  readonly kind: string;
  readonly cwd?: string | undefined;
}

/** Registers this machine and the agent on it, idempotently, and caches their ids. */
export async function registerCloudAgent(
  runtime: CloudRuntime,
  registration: AgentRegistration,
): Promise<CloudAgentRef> {
  const host = hostname();
  const { machine } = await call(runtime, 'POST', '/v1/machines', z.object({ machine: withId }), {
    machineKey: runtime.machineKey,
    name: host,
    hostname: host,
    platform: process.platform,
    runtimeVersion: VERSION,
  });
  const { agent } = await call(runtime, 'POST', '/v1/agents', z.object({ agent: withId }), {
    agentKey: registration.agentKey,
    kind: registration.kind,
    machineId: machine.id,
    pid: process.pid,
    ...(registration.cwd === undefined ? {} : { cwd: registration.cwd }),
  });
  const ref = { agentId: agent.id, machineId: machine.id };
  const cache = readCache(runtime);
  writeCache(runtime, { ...cache, agents: { ...cache.agents, [registration.agentKey]: ref } });
  return ref;
}

/**
 * Runs `work` as the agent, registering it first when its id is not cached,
 * and once more when the cloud no longer knows the cached one.
 */
export async function asCloudAgent<T>(
  runtime: CloudRuntime,
  registration: AgentRegistration,
  work: (agent: CloudAgentRef) => Promise<T>,
): Promise<T> {
  const cached = readCache(runtime).agents[registration.agentKey];
  if (cached === undefined) return work(await registerCloudAgent(runtime, registration));
  try {
    return await work(cached);
  } catch (error) {
    if (!(error instanceof CloudApiError) || ![403, 404].includes(error.status)) throw error;
    return work(await registerCloudAgent(runtime, registration));
  }
}

/** Advertises that the agent drains its own messages, as `registerPullEndpoint` does locally. */
export async function connectPullEndpoint(
  runtime: CloudRuntime,
  agent: CloudAgentRef,
  agentKey: string,
  provider: string,
  capabilities: readonly string[],
): Promise<void> {
  await call(runtime, 'PUT', `/v1/agents/${agent.agentId}/endpoint`, empty, {
    provider,
    transport: 'pull',
    capabilities,
    address: `pull:${agentKey}`,
    // A pull endpoint is never dialled, so it has no credential to hash.
    credentialHash: 'none',
  });
}

/** Promises a running receiver for `ttlSeconds`; while it lasts, only drains take messages. */
export async function renewReceiver(
  runtime: CloudRuntime,
  agent: CloudAgentRef,
  ttlSeconds: number,
): Promise<void> {
  await call(runtime, 'PUT', `/v1/agents/${agent.agentId}/endpoint/receiver`, empty, {
    ttlSeconds,
  });
}

export async function releaseReceiver(runtime: CloudRuntime, agent: CloudAgentRef): Promise<void> {
  await call(runtime, 'DELETE', `/v1/agents/${agent.agentId}/endpoint/receiver`, empty);
}

const messageSchema = z.object({
  id: z.string(),
  senderAgentId: z.string().nullable(),
  taskId: z.string().nullable(),
  replyToMessageId: z.string().nullable(),
  content: z.string(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
});
type CloudMessage = z.infer<typeof messageSchema>;

/**
 * Takes the agent's pending messages, waiting up to `waitSeconds` for one.
 * Exactly once per `drainKey`: a retry with the same key replays its batch.
 */
export async function drainCloud(
  runtime: CloudRuntime,
  agent: CloudAgentRef,
  drainKey: string,
  waitSeconds = 0,
): Promise<readonly CloudMessage[]> {
  const { messages } = await call(
    runtime,
    'POST',
    '/v1/messages/drain',
    z.object({ messages: z.array(messageSchema) }),
    { agentId: agent.agentId, drainKey, waitSeconds: Math.min(waitSeconds, MAX_WAIT_SECONDS) },
    waitSeconds,
  );
  return messages;
}

const agentSchema = z.object({
  id: z.string(),
  agentKey: z.string(),
  kind: z.string(),
  summary: z.string().nullable(),
  status: z.string(),
  lastSeenAt: z.string(),
});
export type CloudAgent = z.infer<typeof agentSchema>;

/** Everyone in the organization, as discovery shows them. */
export async function listCloudAgents(runtime: CloudRuntime): Promise<readonly CloudAgent[]> {
  const { agents } = await call(
    runtime,
    'GET',
    '/v1/agents',
    z.object({ agents: z.array(agentSchema) }),
  );
  return agents;
}

/**
 * Drained messages as the inbox renders them: senders and tasks by the keys
 * agents use, never the cloud's ids.
 */
export async function toDeliverables(
  runtime: CloudRuntime,
  messages: readonly CloudMessage[],
): Promise<DeliverableMessage[]> {
  if (messages.length === 0) return [];
  const keys = new Map((await listCloudAgents(runtime)).map((agent) => [agent.id, agent.agentKey]));
  const taskKeys = new Map<string, string>();
  for (const taskId of new Set(messages.flatMap((message) => message.taskId ?? []))) {
    const { task } = await call(
      runtime,
      'GET',
      `/v1/tasks/${taskId}`,
      z.object({ task: z.object({ taskKey: z.string() }) }),
    );
    taskKeys.set(taskId, task.taskKey);
  }
  return messages.map((message) => ({
    messageId: message.id,
    senderAgentId:
      message.senderAgentId === null ? 'unknown' : (keys.get(message.senderAgentId) ?? 'unknown'),
    taskId: message.taskId === null ? null : (taskKeys.get(message.taskId) ?? null),
    content: message.content,
    messageKind: message.replyToMessageId === null ? 'prompt' : 'reply',
    deliveryLatencyMs:
      message.deliveredAt === null
        ? null
        : Date.parse(message.deliveredAt) - Date.parse(message.createdAt),
  }));
}
