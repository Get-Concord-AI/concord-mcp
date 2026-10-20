import { z } from 'zod';

import type { CloudRuntime } from '../../cloud/runtime.js';
import { listCloudAgents } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import {
  agentIdForSession,
  hookSessionId,
  UNRESOLVED_IDENTITY_MESSAGE,
} from '../../domain/identity.js';
import { buildRoster, deriveLiveness } from '../../domain/presence.js';
import { renderInboxBody, type DeliverableMessage } from '../../domain/pull-inbox.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { launchDetachedConcord } from '../detached-host.js';
import { drainFromCloud, registerInCloud, watching } from './cloud-inbox.js';
import { drainInbox, registerPullEndpoint } from './inbox.js';
import { sessionStartMessage, type RosterLine } from './session-start-message.js';

/**
 * GitHub Copilot CLI lifecycle hooks.
 *
 * Every Copilot hook receives `{ sessionId, cwd, ... }` on stdin, and the MCP
 * server receives the same id as `COPILOT_AGENT_SESSION_ID`, so both derive one
 * agent id. Hooks run with the session's project as `cwd`, but the payload's
 * `cwd` is used because user-level hooks are the ones Concord installs.
 */

const KIND = 'copilot-cli';
/** Copilot caps `additionalContext` from postToolUse at 10 KB. */
const POST_TOOL_CONTEXT_LIMIT = 9_000;

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
    drain: (agentId) => Promise.resolve(drainInbox(repos, agentId, KIND)),
    startLiveHost: (agentId, sessionId, serverAddress) => {
      const endpoint = repos.agentEndpoints.getByAgent(agentId);
      const hosted =
        endpoint?.transport === 'local-ipc' &&
        endpoint.status === 'connected' &&
        (endpoint.expiresAt === null || Date.parse(endpoint.expiresAt) > Date.now());
      if (!hosted) launchDetachedConcord(repoRoot, hostArgs(agentId, sessionId, serverAddress));
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

function agentIdFor(rawJson: string): string | undefined {
  const sessionId = hookSessionId(rawJson);
  return sessionId === undefined ? undefined : agentIdForSession(KIND, sessionId);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * sessionStart: register the session, advertise it as reachable, and tell it
 * who it is and who else is here through `additionalContext`.
 */
export async function copilotSessionStart(
  backend: CopilotHookBackend,
  rawJson: string,
  serverAddress?: string,
): Promise<string> {
  const sessionId = hookSessionId(rawJson);
  if (sessionId === undefined) {
    return JSON.stringify({ additionalContext: `Concord: ${UNRESOLVED_IDENTITY_MESSAGE}` });
  }
  const agentId = agentIdForSession(KIND, sessionId);
  try {
    await backend.register(agentId, copilotWorkspace(rawJson));
    // Started by `concord adapters copilot`: a host can reach the idle session.
    if (serverAddress !== undefined) backend.startLiveHost(agentId, sessionId, serverAddress);
    const others = await backend.roster(agentId);
    return JSON.stringify({ additionalContext: sessionStartMessage(agentId, others) });
  } catch (error) {
    return JSON.stringify({ additionalContext: `Concord could not register: ${describe(error)}` });
  }
}

/** postToolUse: deliver waiting messages mid-turn, within Copilot's context cap. */
export async function copilotPostToolUse(
  backend: CopilotHookBackend,
  rawJson: string,
): Promise<string> {
  const agentId = agentIdFor(rawJson);
  if (agentId === undefined) return '{}';
  try {
    const messages = await backend.drain(agentId);
    if (messages.length === 0) return '{}';
    const context = `[concord] Incoming message(s):\n\n${renderInboxBody(messages)}`;
    return JSON.stringify({
      additionalContext:
        context.length <= POST_TOOL_CONTEXT_LIMIT
          ? context
          : `${context.slice(0, POST_TOOL_CONTEXT_LIMIT)}\n\n[concord] Truncated at ` +
            "Copilot's context limit for tool hooks.",
    });
  } catch {
    return '{}';
  }
}

/**
 * agentStop: when a message arrived after the last tool call, block the stop
 * so the message becomes the next turn's prompt instead of waiting for the
 * user. Copilot itself stops honouring blocks after eight in a row.
 */
export async function copilotAgentStop(
  backend: CopilotHookBackend,
  rawJson: string,
): Promise<string> {
  const agentId = agentIdFor(rawJson);
  if (agentId === undefined) return '{}';
  try {
    const messages = await backend.drain(agentId);
    if (messages.length === 0) return '{}';
    return JSON.stringify({
      decision: 'block',
      reason: `New Concord message(s) arrived before this turn ended.\n\n${renderInboxBody(messages)}`,
    });
  } catch {
    return '{}';
  }
}

/** Run one Copilot hook event; unknown events are reported, never fatal to the session. */
export async function runCopilotHook(
  backend: CopilotHookBackend,
  event: string,
  rawJson: string,
  serverAddress?: string,
): Promise<string | undefined> {
  switch (event) {
    case 'session-start':
      return copilotSessionStart(backend, rawJson, serverAddress);
    case 'post-tool-use':
      return copilotPostToolUse(backend, rawJson);
    case 'stop':
      return copilotAgentStop(backend, rawJson);
    default:
      return undefined;
  }
}
