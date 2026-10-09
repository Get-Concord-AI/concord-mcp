import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { toDeliverable, type DeliverableMessage } from '../domain/pull-inbox.js';
import { VERSION } from '../version.js';
import { errorDetail, sameApi, TIMEOUT_MS, url, type Fetch } from './client.js';
import type { CloudSession } from './proxy.js';

/**
 * A session's runtime against Concord Cloud: what the inbox commands and the
 * session-start hook do locally over SQLite, done over the cloud's REST API.
 *
 * Agents are named by the runtime's own key; the cloud's ids for this machine
 * and its agents are kept in `.concord/cloud-agents/`, one file each, so a hook that runs
 * after every tool call costs one request rather than four. A cached id the
 * cloud no longer knows is registered again and the call retried once.
 */

export type CloudRuntime = Pick<
  CloudSession,
  'apiUrl' | 'bearer' | 'machineKey' | 'projectKey' | 'repoRoot' | 'checkoutRoot'
> & {
  readonly fetch: Fetch;
  /**
   * When everything this runtime is asked to do must be over, in ms since the
   * epoch: a hook runs inside its harness's own limit, retries included.
   * Without one, each request has the usual timeout.
   */
  readonly deadline?: number;
};

/** A drain waits at most this long; the cloud allows 25 seconds. */
export const MAX_WAIT_SECONDS = 25;

/** An answer the cloud gave that was not a success. */
export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** `work`, unless `signal` gives up on it first: then a timeout, as a request's own would be. */
function before<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const giveUp = (): void => {
      reject(new DOMException('Concord Cloud did not answer in time.', 'TimeoutError'));
    };
    if (signal.aborted) {
      giveUp();
      return;
    }
    signal.addEventListener('abort', giveUp, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', giveUp);
    });
  });
}

async function call<T>(
  runtime: CloudRuntime,
  method: string,
  path: string,
  schema: z.ZodType<T>,
  body?: object,
  waitSeconds = 0,
  signal?: AbortSignal,
): Promise<T> {
  // A cold Cloud Run start is the slow case; a long-poll adds its wait.
  const budget =
    runtime.deadline === undefined
      ? TIMEOUT_MS + waitSeconds * 1000
      : Math.max(0, runtime.deadline - Date.now());
  const timeout = AbortSignal.timeout(budget);
  // Within the same budget: a browser login refreshing its token is a request
  // too, and ends with it rather than keeping a hook's process alive.
  const token = await before(runtime.bearer(timeout), timeout);
  const response = await runtime.fetch(url(runtime.apiUrl, path), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
  });
  if (!response.ok) {
    throw new CloudApiError(
      response.status,
      `Concord Cloud answered ${String(response.status)} to ${method} ${path}: ${await errorDetail(response)}`,
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

const cacheSchema = cachedAgent.extend({
  apiUrl: z.string(),
  machineKey: z.string(),
  /** Until when a running `inbox watch` holds this agent's receiver, in ms. */
  watchingUntil: z.number().optional(),
});
export type CloudAgentState = z.infer<typeof cacheSchema>;

/**
 * One file per agent, so sessions registering at once never overwrite each
 * other's ids. The key is hashed into the name: agent keys hold `:` and are
 * chosen by the runtime, never fit to be a path as written.
 */
export function agentCachePath(repoRoot: string, agentKey: string): string {
  const name = createHash('sha256').update(agentKey).digest('hex').slice(0, 16);
  return join(repoRoot, '.concord', 'cloud-agents', `${name}.json`);
}

/** What this machine knows of the agent, when it was recorded for this API and machine. */
export function readAgentState(
  runtime: CloudRuntime,
  agentKey: string,
): CloudAgentState | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(agentCachePath(runtime.repoRoot, agentKey), 'utf8'),
    );
    const parsed = cacheSchema.safeParse(raw);
    return parsed.success &&
      sameApi(parsed.data.apiUrl, runtime.apiUrl) &&
      parsed.data.machineKey === runtime.machineKey
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

/** Records the agent's ids, or changes what is known of it; a no-op before its ids are known. */
export function updateAgentState(
  runtime: CloudRuntime,
  agentKey: string,
  change: { readonly [K in keyof CloudAgentState]?: CloudAgentState[K] | undefined },
): void {
  const current = readAgentState(runtime, agentKey);
  const next = { ...current, ...change, apiUrl: runtime.apiUrl, machineKey: runtime.machineKey };
  const parsed = cacheSchema.safeParse(next);
  if (!parsed.success) return;
  const path = agentCachePath(runtime.repoRoot, agentKey);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(parsed.data, null, 2)}\n`);
  renameSync(temp, path);
}

/** A drain's key, held from before it asks until its answer has arrived. */
export interface DrainTicket {
  readonly key: string;
  /** True when this key's drain may already have happened, so the cloud replays it. */
  readonly replay: boolean;
  /** The answer arrived: nothing left to replay. */
  readonly finish: () => void;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, and belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * A key for the agent's next drain. Each drain in flight is a file named for
 * its key and its process, removed once answered; one left by a process that
 * has ended had its answer lost, and is taken over (by an atomic rename) so
 * the cloud replays its batch. A key another running process holds is never
 * reused, so two drains can never share one and see one batch twice.
 */
export function takeDrainKey(runtime: CloudRuntime, agentKey: string): DrainTicket {
  const dir = agentCachePath(runtime.repoRoot, agentKey).replace(/\.json$/, '.drains');
  mkdirSync(dir, { recursive: true });
  const ticket = (key: string, replay: boolean): DrainTicket => {
    const path = join(dir, `${key}.${String(process.pid)}`);
    return {
      key,
      replay,
      finish: () => {
        rmSync(path, { force: true });
      },
    };
  };
  for (const name of readdirSync(dir)) {
    const [key, owner] = name.split('.');
    const pid = Number(owner);
    if (key === undefined || (pid !== process.pid && running(pid))) continue;
    try {
      renameSync(join(dir, name), join(dir, `${key}.${String(process.pid)}`));
      return ticket(key, true);
    } catch {
      // Taken over by another process first.
    }
  }
  const key = randomUUID();
  writeFileSync(join(dir, `${key}.${String(process.pid)}`), '');
  return ticket(key, false);
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
  updateAgentState(runtime, registration.agentKey, ref);
  return ref;
}

/**
 * Runs `work` as the agent, registering it first when its id is not cached,
 * and once more when the cloud no longer knows the cached one. Any other
 * refusal is the caller's to see: retrying it would only repeat it.
 */
export async function asCloudAgent<T>(
  runtime: CloudRuntime,
  registration: AgentRegistration,
  work: (agent: CloudAgentRef) => Promise<T>,
  onRegistered: (agent: CloudAgentRef) => Promise<void> = () => Promise.resolve(),
): Promise<T> {
  const register = async (): Promise<CloudAgentRef> => {
    const agent = await registerCloudAgent(runtime, registration);
    try {
      await onRegistered(agent);
    } catch (error) {
      // Not cached until finished, so the next call registers it again.
      rmSync(agentCachePath(runtime.repoRoot, registration.agentKey), { force: true });
      throw error;
    }
    return agent;
  };
  const state = readAgentState(runtime, registration.agentKey);
  if (state === undefined) return work(await register());
  const cached = { agentId: state.agentId, machineId: state.machineId };
  try {
    return await work(cached);
  } catch (error) {
    if (!(error instanceof CloudApiError) || ![403, 404].includes(error.status)) throw error;
    if (await agentExists(runtime, cached)) throw error;
    return work(await register());
  }
}

/** Whether the cloud still has this agent, for this caller. */
async function agentExists(runtime: CloudRuntime, agent: CloudAgentRef): Promise<boolean> {
  try {
    await call(runtime, 'GET', `/v1/agents/${agent.agentId}`, z.object({ agent: withId }));
    return true;
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) return false;
    throw error;
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
  senderAgentKey: z.string().nullable(),
  taskKey: z.string().nullable(),
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
  signal?: AbortSignal,
): Promise<readonly CloudMessage[]> {
  const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(waitSeconds)));
  const { messages } = await call(
    runtime,
    'POST',
    '/v1/messages/drain',
    z.object({ messages: z.array(messageSchema) }),
    { agentId: agent.agentId, drainKey, waitSeconds: wait },
    wait,
    signal,
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
 * agents use, which the drain itself returns, so rendering needs no request
 * that could fail after the messages were taken.
 */
export function toDeliverables(messages: readonly CloudMessage[]): DeliverableMessage[] {
  return messages.map((message) =>
    toDeliverable({
      messageId: message.id,
      senderAgentId: message.senderAgentKey ?? 'unknown',
      taskId: message.taskKey,
      content: message.content,
      replyToMessageId: message.replyToMessageId,
      createdAt: message.createdAt,
      deliveredAt: message.deliveredAt,
    }),
  );
}

const claimSchema = z.object({
  file: z.string(),
  taskKey: z.string(),
  title: z.string(),
  status: z.string(),
  agentKey: z.string().nullable(),
});
export type CloudClaim = z.infer<typeof claimSchema>;

/** Who holds these repository files in the linked project, by the cloud's live claims. */
export async function listClaims(
  runtime: CloudRuntime,
  files: readonly string[],
  signal?: AbortSignal,
): Promise<readonly CloudClaim[]> {
  const query = new URLSearchParams({ projectKey: runtime.projectKey });
  for (const file of files) query.append('file', file);
  const { claims } = await call(
    runtime,
    'GET',
    `/v1/claims?${query.toString()}`,
    z.object({ claims: z.array(claimSchema) }),
    undefined,
    0,
    signal,
  );
  return claims;
}

/** The most tasks the cloud returns at once. */
export const TASK_PAGE = 200;

const taskSchema = z.object({
  taskKey: z.string(),
  title: z.string(),
  status: z.string(),
  version: z.number(),
  agentId: z.string().nullable(),
  assignedAgentId: z.string().nullable(),
  updatedAt: z.string(),
});
export type CloudTask = z.infer<typeof taskSchema>;

/** The linked project's tasks, most recently updated first, as many as the cloud gives at once. */
export async function listCloudTasks(runtime: CloudRuntime): Promise<readonly CloudTask[]> {
  const query = new URLSearchParams({ projectKey: runtime.projectKey, limit: String(TASK_PAGE) });
  const { tasks } = await call(
    runtime,
    'GET',
    `/v1/tasks?${query.toString()}`,
    z.object({ tasks: z.array(taskSchema) }),
  );
  return tasks;
}

/**
 * Records that a drained message could not be handed to its session, so its
 * sender sees it failed rather than taking silence for delivery.
 */
export async function reportDeliveryFailure(
  runtime: CloudRuntime,
  agent: CloudAgentRef,
  messageId: string,
  detail: string,
): Promise<void> {
  await call(runtime, 'POST', `/v1/messages/${messageId}/failure`, z.object({}).loose(), {
    agentId: agent.agentId,
    errorCode: 'target_not_promptable',
    errorDetail: detail.slice(0, 5000),
  });
}
