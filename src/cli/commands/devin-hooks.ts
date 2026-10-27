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
 * Devin CLI lifecycle hooks (`.devin/hooks.v1.json`). Devin passes its session
 * id on stdin, never to the MCP server, so the session-start context tells the
 * model which agent_id to pass on writes. In a repository linked to Concord
 * Cloud the session registers and drains there, as every other hook does.
 */

export const DEVIN_HOOK_EVENTS = [
  'devin-session-start',
  'devin-user-prompt-submit',
  'devin-session-end',
] as const;
export type DevinHookEvent = (typeof DEVIN_HOOK_EVENTS)[number];

export function isDevinHookEvent(event: string): event is DevinHookEvent {
  return DEVIN_HOOK_EVENTS.some((known) => known === event);
}

const NO_OUTPUT = JSON.stringify({});

export function devinSessionStartOutput(agentId: string, others: readonly RosterLine[]): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: sessionStartMessage(agentId, others, true),
    },
  });
}

/** Devin forwards an empty additionalContext to the model, which rejects the whole request. */
export function devinPromptSubmitOutput(messages: readonly DeliverableMessage[]): string {
  if (messages.length === 0) return NO_OUTPUT;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: renderInboxBody(messages),
    },
  });
}

export function endDevinSession(repos: Repositories, agentId: string): void {
  const endpoint = repos.agentEndpoints.getByAgent(agentId);
  if (endpoint !== undefined) repos.agentEndpoints.disconnect(endpoint.endpointId);
}

export function handleLocalDevinHook(
  repos: Repositories,
  identity: AgentIdentity,
  repoRoot: string,
  event: DevinHookEvent,
): string {
  switch (event) {
    case 'devin-session-start':
      ensureAgentRegistered(repos, identity, repoRoot);
      registerPullEndpoint(repos, identity.agentId, 'devin');
      return devinSessionStartOutput(
        identity.agentId,
        buildRoster(repos.agents.list(), Date.now()).filter(
          (peer) => peer.agentId !== identity.agentId,
        ),
      );
    case 'devin-user-prompt-submit':
      return devinPromptSubmitOutput(drainInbox(repos, identity.agentId, 'devin'));
    case 'devin-session-end':
      endDevinSession(repos, identity.agentId);
      return NO_OUTPUT;
  }
}

/**
 * The cloud has no endpoint disconnect: presence there lapses with `last_seen`,
 * and messages wait for the next session either way, so session end is a no-op.
 */
export async function handleCloudDevinHook(
  runtime: CloudRuntime,
  identity: AgentIdentity,
  cwd: string,
  event: DevinHookEvent,
): Promise<string> {
  switch (event) {
    case 'devin-session-start':
      await registerInCloud(runtime, identity.agentId, 'devin', cwd);
      return devinSessionStartOutput(
        identity.agentId,
        await cloudRoster(runtime, identity.agentId),
      );
    case 'devin-user-prompt-submit':
      return devinPromptSubmitOutput(await drainFromCloud(runtime, identity.agentId, 'devin'));
    case 'devin-session-end':
      return NO_OUTPUT;
  }
}

/**
 * Never blocks the Devin session: an unidentifiable payload or an unreachable
 * cloud yields no context (and a note on stderr), not a failed hook.
 */
export async function runDevinHook(
  event: DevinHookEvent,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const identity = resolveIdentity(env, { kind: 'devin', hookPayload: rawJson });
  if (identity === undefined) return NO_OUTPUT;
  // Devin sets DEVIN_PROJECT_DIR to the hook's project root.
  const repoRoot = env['DEVIN_PROJECT_DIR'] ?? process.cwd();
  const access = cloudAccess(repoRoot, { timeoutMs: HOOK_TIMEOUT_MS }, env);
  if (access.kind === 'unusable') {
    process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
    return NO_OUTPUT;
  }
  if (access.kind === 'local') {
    return handleLocalDevinHook(openContext(repoRoot, env).repos, identity, repoRoot, event);
  }
  try {
    return await handleCloudDevinHook(access.runtime, identity, repoRoot, event);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Concord Cloud could not be reached: ${detail}\n`);
    return NO_OUTPUT;
  }
}
