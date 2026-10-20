import { z } from 'zod';

import type { CloudRuntime } from '../../cloud/runtime.js';
import { listCloudAgents } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import {
  hookSessionId,
  resolveIdentity,
  UNRESOLVED_IDENTITY_MESSAGE,
} from '../../domain/identity.js';
import { buildRoster, deriveLiveness } from '../../domain/presence.js';
import { renderInboxBody, type DeliverableMessage } from '../../domain/pull-inbox.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { launchDetachedConcord } from '../detached-host.js';
import { drainFromCloud, registerInCloud, watching } from './cloud-inbox.js';
import type { MessageSpool } from './copilot-spool.js';
import { drainInbox, registerPullEndpoint } from './inbox.js';
import { sessionStartMessage, type RosterLine } from './session-start-message.js';

/**
 * GitHub Copilot CLI lifecycle hooks.
 *
 * Every Copilot hook receives `{ sessionId, cwd, ... }` on stdin, and the MCP
 * server receives the same id as `COPILOT_AGENT_SESSION_ID`, so both derive one
 * agent id — or both use `CONCORD_AGENT_ID` when the operator set it in the
 * environment Copilot was started from. Hooks run with the session's project
 * as `cwd`, but the payload's `cwd` is used because user-level hooks are the
 * ones Concord installs.
 */

const KIND = 'copilot-cli';
/** Copilot caps `additionalContext` from postToolUse at 10 KB. */
const POST_TOOL_CONTEXT_LIMIT = 9_000;
/**
 * A sender keeps a message pending while it pushes it to a live host (at most
 * a 1.5 s attempt and one retry). Hooks of a hosted session leave messages that
 * young to the push, so Copilot never receives one twice (#261).
 */
const PUSH_GRACE_MS = 10_000;
const POST_TOOL_HEADER = '[concord] Incoming message(s):\n\n';

const payloadSchema = z.object({ cwd: z.string().optional() }).loose();

/** Where a Copilot hook's session lives and what it may do there. */
export interface CopilotHookBackend {
  register(agentId: string, cwd: string): Promise<void>;
  roster(agentId: string): Promise<RosterLine[]>;
  drain(agentId: string): Promise<DeliverableMessage[]>;
  /** Start a live host for a launcher session, unless one already serves it (#261). */
  startLiveHost(agentId: string, sessionId: string, serverAddress: string): void;
}

function hostArgs(agentId: string, sessionId: string, serverAddress: string): string[] {
  return [
    'adapters',
    'host-copilot',
    '--agent',
    agentId,
    '--session',
    sessionId,
    '--server',
    serverAddress,
  ];
}

/** The workspace a Copilot hook is for: its payload's `cwd`, else the process's. */
export function copilotWorkspace(rawJson: string): string {
  try {
    const raw: unknown = JSON.parse(rawJson);
    const parsed = payloadSchema.safeParse(raw);
    return (parsed.success ? parsed.data.cwd : undefined) ?? process.cwd();
  } catch {
    return process.cwd();
  }
}

export function localCopilotBackend(repos: Repositories, repoRoot: string): CopilotHookBackend {
  const hosted = (agentId: string): boolean => {
    const endpoint = repos.agentEndpoints.getByAgent(agentId);
    return (
      endpoint?.transport === 'local-ipc' &&
      endpoint.status === 'connected' &&
      (endpoint.expiresAt === null || Date.parse(endpoint.expiresAt) > Date.now())
    );
  };
  return {
    register: (agentId, cwd) => {
      ensureAgentRegistered(repos, { agentId, kind: KIND }, cwd);
      registerPullEndpoint(repos, agentId, KIND);
      return Promise.resolve();
    },
    roster: (agentId) =>
      Promise.resolve(
        buildRoster(repos.agents.list(), Date.now()).filter((entry) => entry.agentId !== agentId),
      ),
    drain: (agentId) => {
      const createdBefore = hosted(agentId)
        ? new Date(Date.now() - PUSH_GRACE_MS).toISOString()
        : undefined;
      return Promise.resolve(drainInbox(repos, agentId, KIND, undefined, createdBefore));
    },
    startLiveHost: (agentId, sessionId, serverAddress) => {
      if (!hosted(agentId)) {
        launchDetachedConcord(repoRoot, hostArgs(agentId, sessionId, serverAddress));
      }
    },
  };
}

export function cloudCopilotBackend(runtime: CloudRuntime): CopilotHookBackend {
  return {
    register: async (agentId, cwd) => {
      await registerInCloud(runtime, agentId, KIND, cwd);
    },
    roster: async (agentId) => {
      const now = Date.now();
      return (await listCloudAgents(runtime))
        .filter((agent) => agent.agentKey !== agentId)
        .map((agent) => ({
          agentId: agent.agentKey,
          liveness: deriveLiveness(agent.lastSeenAt, now),
          status: agent.status,
          summary: agent.summary,
        }))
        .filter((peer) => peer.liveness !== 'archived');
    },
    drain: (agentId) => drainFromCloud(runtime, agentId, KIND),
    startLiveHost: (agentId, sessionId, serverAddress) => {
      if (!watching(runtime, agentId)) {
        launchDetachedConcord(runtime.repoRoot, hostArgs(agentId, sessionId, serverAddress));
      }
    },
  };
}

/** What one hook invocation works with. */
export interface CopilotHookContext {
  readonly backend: CopilotHookBackend;
  readonly spool: MessageSpool;
  /** The hook's environment: `CONCORD_AGENT_ID` and the launcher's address live here. */
  readonly env: NodeJS.ProcessEnv;
  /** The embedded server of a session `concord adapters copilot` started. */
  readonly serverAddress?: string | undefined;
}

/** The same identity rules the MCP server applies: operator id, then the session. */
function agentIdFor(rawJson: string, env: NodeJS.ProcessEnv): string | undefined {
  return resolveIdentity(env, { kind: KIND, hookPayload: rawJson })?.agentId;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * sessionStart: register the session, advertise it as reachable, and tell it
 * who it is and who else is here through `additionalContext`.
 */
export async function copilotSessionStart(
  context: CopilotHookContext,
  rawJson: string,
): Promise<string> {
  const sessionId = hookSessionId(rawJson);
  const agentId = agentIdFor(rawJson, context.env);
  if (sessionId === undefined || agentId === undefined) {
    return JSON.stringify({ additionalContext: `Concord: ${UNRESOLVED_IDENTITY_MESSAGE}` });
  }
  try {
    await context.backend.register(agentId, copilotWorkspace(rawJson));
    // Started by `concord adapters copilot`: a host can reach the idle session.
    if (context.serverAddress !== undefined) {
      context.backend.startLiveHost(agentId, sessionId, context.serverAddress);
    }
    const others = await context.backend.roster(agentId);
    return JSON.stringify({ additionalContext: sessionStartMessage(agentId, others) });
  } catch (error) {
    return JSON.stringify({ additionalContext: `Concord could not register: ${describe(error)}` });
  }
}

/** Spooled messages first, then any newly drained, in arrival order. */
async function waiting(
  context: CopilotHookContext,
  agentId: string,
): Promise<DeliverableMessage[]> {
  const spooled = context.spool.take(agentId);
  try {
    return [...spooled, ...(await context.backend.drain(agentId))];
  } catch {
    return spooled;
  }
}

/**
 * The longest prefix of `messages` whose rendering fits `limit`. Order is kept:
 * once one message does not fit, it and everything after it wait.
 */
export function fittingPrefix(
  messages: readonly DeliverableMessage[],
  limit: number,
): DeliverableMessage[] {
  const fit: DeliverableMessage[] = [];
  for (const message of messages) {
    if (POST_TOOL_HEADER.length + renderInboxBody([...fit, message]).length > limit) break;
    fit.push(message);
  }
  return fit;
}

/**
 * postToolUse: deliver waiting messages mid-turn. Only whole messages that fit
 * Copilot's context cap are shown; the rest are spooled for the next hook.
 */
export async function copilotPostToolUse(
  context: CopilotHookContext,
  rawJson: string,
): Promise<string> {
  const agentId = agentIdFor(rawJson, context.env);
  if (agentId === undefined) return '{}';
  const messages = await waiting(context, agentId);
  if (messages.length === 0) return '{}';
  const shown = fittingPrefix(messages, POST_TOOL_CONTEXT_LIMIT);
  context.spool.put(agentId, messages.slice(shown.length));
  return JSON.stringify({
    additionalContext:
      shown.length > 0
        ? `${POST_TOOL_HEADER}${renderInboxBody(shown)}`
        : '[concord] A message too long to show here is waiting; it arrives when this turn ends.',
  });
}

/**
 * agentStop: when messages are waiting — spooled, or arrived after the last
 * tool call — block the stop so they become the next turn's prompt instead of
 * waiting for the user. Copilot itself stops honouring blocks after eight in a row.
 */
export async function copilotAgentStop(
  context: CopilotHookContext,
  rawJson: string,
): Promise<string> {
  const agentId = agentIdFor(rawJson, context.env);
  if (agentId === undefined) return '{}';
  const messages = await waiting(context, agentId);
  if (messages.length === 0) return '{}';
  return JSON.stringify({
    decision: 'block',
    reason: `New Concord message(s) arrived before this turn ended.\n\n${renderInboxBody(messages)}`,
  });
}

/** Run one Copilot hook event; unknown events are reported, never fatal to the session. */
export async function runCopilotHook(
  context: CopilotHookContext,
  event: string,
  rawJson: string,
): Promise<string | undefined> {
  switch (event) {
    case 'session-start':
      return copilotSessionStart(context, rawJson);
    case 'post-tool-use':
      return copilotPostToolUse(context, rawJson);
    case 'stop':
      return copilotAgentStop(context, rawJson);
    default:
      return undefined;
  }
}
