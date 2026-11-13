import type { CloudRuntime } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import { resolveIdentity, type AgentIdentity } from '../../domain/identity.js';
import { buildRoster } from '../../domain/presence.js';
import { renderInboxBody, type DeliverableMessage } from '../../domain/pull-inbox.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { openContext } from '../context.js';
import { cloudRoster } from './cloud-hooks.js';
import { cloudAccess, drainFromCloud, HOOK_TIMEOUT_MS, registerInCloud } from './cloud-inbox.js';
import { drainInbox, registerPullEndpoint } from './inbox.js';
import { sessionStartMessage, type RosterLine } from './session-start-message.js';

/**
 * Junie CLI lifecycle hooks (`~/.junie/config.json`). Junie passes its session
 * id on stdin to hook commands. In a repository linked to Concord Cloud the
 * session registers and drains there, as every other hook does.
 */

export const JUNIE_HOOK_EVENTS = [
  'junie-session-start',
  'junie-user-prompt-submit',
  'junie-session-end',
] as const;
export type JunieHookEvent = (typeof JUNIE_HOOK_EVENTS)[number];

export function isJunieHookEvent(event: string): event is JunieHookEvent {
  return JUNIE_HOOK_EVENTS.some((known) => known === event);
}

const NO_OUTPUT = JSON.stringify({});

export function junieSessionStartOutput(agentId: string, others: readonly RosterLine[]): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: sessionStartMessage(agentId, others, true),
    },
  });
}

/** Junie forwards an empty additionalContext to the model, which rejects the whole request. */
export function juniePromptSubmitOutput(messages: readonly DeliverableMessage[]): string {
  if (messages.length === 0) return NO_OUTPUT;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: renderInboxBody(messages),
    },
  });
}

export function endJunieSession(repos: Repositories, agentId: string): void {
  const endpoint = repos.agentEndpoints.getByAgent(agentId);
  if (endpoint !== undefined) repos.agentEndpoints.disconnect(endpoint.endpointId);
}

export function handleLocalJunieHook(
  repos: Repositories,
  identity: AgentIdentity,
  repoRoot: string,
  event: JunieHookEvent,
): string {
  switch (event) {
    case 'junie-session-start':
      ensureAgentRegistered(repos, identity, repoRoot);
      registerPullEndpoint(repos, identity.agentId, 'junie');
      return junieSessionStartOutput(
        identity.agentId,
        buildRoster(repos.agents.list(), Date.now()).filter(
          (peer) => peer.agentId !== identity.agentId,
        ),
      );
    case 'junie-user-prompt-submit':
      return juniePromptSubmitOutput(drainInbox(repos, identity.agentId, 'junie'));
    case 'junie-session-end':
      endJunieSession(repos, identity.agentId);
      return NO_OUTPUT;
  }
}

/**
 * The cloud has no endpoint disconnect: presence there lapses with `last_seen`,
 * and messages wait for the next session either way, so session end is a no-op.
 */
export async function handleCloudJunieHook(
  runtime: CloudRuntime,
  identity: AgentIdentity,
  cwd: string,
  event: JunieHookEvent,
): Promise<string> {
  switch (event) {
    case 'junie-session-start':
      await registerInCloud(runtime, identity.agentId, 'junie', cwd);
      return junieSessionStartOutput(
        identity.agentId,
        await cloudRoster(runtime, identity.agentId),
      );
    case 'junie-user-prompt-submit':
      return juniePromptSubmitOutput(await drainFromCloud(runtime, identity.agentId, 'junie'));
    case 'junie-session-end':
      return NO_OUTPUT;
  }
}

/**
 * Never blocks the Junie session: an unidentifiable payload or an unreachable
 * cloud yields no context (and a note on stderr), not a failed hook.
 */
export async function runJunieHook(
  event: JunieHookEvent,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const identity = resolveIdentity(env, { kind: 'junie', hookPayload: rawJson });
  if (identity === undefined) return NO_OUTPUT;
  const repoRoot = env['JUNIE_PROJECT_DIR'] ?? process.cwd();
  const access = cloudAccess(repoRoot, { timeoutMs: HOOK_TIMEOUT_MS }, env);
  if (access.kind === 'unusable') {
    process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
    return NO_OUTPUT;
  }
  if (access.kind === 'local') {
    return handleLocalJunieHook(openContext(repoRoot, env).repos, identity, repoRoot, event);
  }
  try {
    return await handleCloudJunieHook(access.runtime, identity, repoRoot, event);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Concord Cloud could not be reached: ${detail}\n`);
    return NO_OUTPUT;
  }
}
