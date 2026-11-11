import { join } from 'node:path';

import { z } from 'zod';

import type { CloudRuntime } from '../../cloud/runtime.js';
import { hermesSessionCwd } from '../../db/hermes-session.js';
import type { Repositories } from '../../db/index.js';
import { hookSessionId, resolveIdentity, type AgentIdentity } from '../../domain/identity.js';
import { buildRoster } from '../../domain/presence.js';
import { renderInboxBody, type DeliverableMessage } from '../../domain/pull-inbox.js';
import { hermesHome } from '../../install/hermes-config.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { openContext } from '../context.js';
import { cloudRoster } from './cloud-hooks.js';
import { cloudAccess, drainFromCloud, HOOK_TIMEOUT_MS, registerInCloud } from './cloud-inbox.js';
import { drainInbox } from './inbox.js';
import { hermesSessionStartMessage, type RosterLine } from './session-start-message.js';

/**
 * Hermes Agent's `pre_llm_call` shell hook, which runs once at the start of
 * every turn with the session id on stdin. It is Concord's only view of a
 * Hermes session: the MCP server is shared by every session in the process and
 * started from `$HOME`. On a session's first turn the hook registers it and
 * tells the model its `agent_id` and `workspace_id`; on every turn it hands the
 * model the messages waiting for it. Hermes injects `context` into the turn's
 * user message, so delivery happens at turn boundaries, not mid-turn.
 */

export const HERMES_HOOK_EVENTS = ['hermes-pre-llm-call'] as const;
export type HermesHookEvent = (typeof HERMES_HOOK_EVENTS)[number];

export function isHermesHookEvent(event: string): event is HermesHookEvent {
  return HERMES_HOOK_EVENTS.some((known) => known === event);
}

const PROVIDER = 'hermes';
const NO_OUTPUT = JSON.stringify({});

const payloadSchema = z
  .object({ extra: z.object({ is_first_turn: z.boolean().optional() }).loose().optional() })
  .loose();

/** Whether this turn opens the session; an unreadable payload counts as one, so the id is said. */
function firstTurn(rawJson: string): boolean {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(rawJson));
    return !parsed.success || parsed.data.extra?.is_first_turn !== false;
  } catch {
    return true;
  }
}

export function hermesHookOutput(
  start:
    | {
        readonly agentId: string;
        readonly workspaceId: string | undefined;
        readonly others: readonly RosterLine[];
      }
    | undefined,
  messages: readonly DeliverableMessage[],
): string {
  const parts = [
    ...(start === undefined
      ? []
      : [hermesSessionStartMessage(start.agentId, start.workspaceId, start.others)]),
    ...(messages.length === 0 ? [] : [renderInboxBody(messages)]),
  ];
  return parts.length === 0 ? NO_OUTPUT : JSON.stringify({ context: parts.join('\n\n') });
}

export function handleLocalHermesHook(
  repos: Repositories,
  identity: AgentIdentity,
  workspace: { readonly workspaceId: string; readonly repoRoot: string },
  first: boolean,
): string {
  ensureAgentRegistered(repos, identity, workspace.repoRoot);
  const start = first
    ? {
        agentId: identity.agentId,
        workspaceId: workspace.workspaceId,
        others: buildRoster(repos.agents.list(), Date.now()).filter(
          (peer) => peer.agentId !== identity.agentId,
        ),
      }
    : undefined;
  return hermesHookOutput(start, drainInbox(repos, identity.agentId, PROVIDER));
}

export async function handleCloudHermesHook(
  runtime: CloudRuntime,
  identity: AgentIdentity,
  cwd: string,
  first: boolean,
): Promise<string> {
  await registerInCloud(runtime, identity.agentId, PROVIDER, cwd);
  const start = first
    ? {
        agentId: identity.agentId,
        workspaceId: undefined,
        others: await cloudRoster(runtime, identity.agentId),
      }
    : undefined;
  return hermesHookOutput(start, await drainFromCloud(runtime, identity.agentId, PROVIDER));
}

/**
 * Never blocks the Hermes turn: a payload without a session, a session whose
 * project Hermes did not record, or an unreachable cloud yields no context
 * (and a note on stderr), never a guess at the workspace.
 */
export async function runHermesHook(
  _event: HermesHookEvent,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const sessionId = hookSessionId(rawJson);
  const identity = resolveIdentity(env, { kind: PROVIDER, hookPayload: rawJson });
  if (sessionId === undefined || identity === undefined) return NO_OUTPUT;
  const cwd = hermesSessionCwd(join(hermesHome(env), 'state.db'), sessionId);
  if (cwd === undefined) {
    process.stderr.write(
      `Concord: Hermes recorded no working directory for session ${sessionId}.\n`,
    );
    return NO_OUTPUT;
  }
  // The session's directory is the project, whatever this process inherited.
  const projectEnv = { ...env, CONCORD_REPO_ROOT: cwd };
  const first = firstTurn(rawJson);
  const access = cloudAccess(cwd, { timeoutMs: HOOK_TIMEOUT_MS }, projectEnv);
  if (access.kind === 'unusable') {
    process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
    return NO_OUTPUT;
  }
  if (access.kind === 'local') {
    const context = openContext(cwd, projectEnv);
    try {
      return handleLocalHermesHook(context.repos, identity, context, first);
    } finally {
      // Hand the store back before returning: an open handle keeps Windows from removing it.
      context.repos.db.close();
    }
  }
  try {
    return await handleCloudHermesHook(access.runtime, identity, cwd, first);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Concord Cloud could not be reached: ${detail}\n`);
    return NO_OUTPUT;
  }
}
