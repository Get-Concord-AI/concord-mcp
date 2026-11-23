import { z } from 'zod';

import type { CloudRuntime } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import { resolveIdentity, type AgentIdentity } from '../../domain/identity.js';
import { buildRoster } from '../../domain/presence.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { cloudRoster } from './cloud-hooks.js';
import { cloudAccess, registerInCloud, HOOK_TIMEOUT_MS } from './cloud-inbox.js';
import { isSubagentHook, observeHookEvent, parseObservedHook } from './inbox-observe.js';
import { registerPullEndpoint } from './inbox.js';
import {
  sessionStartMessage,
  VIBE_SESSION_IDENTITY,
  type RosterLine,
} from './session-start-message.js';

/**
 * Mistral Vibe lifecycle hooks (`.vibe/hooks.toml` and `~/.vibe/hooks.toml`).
 * Vibe passes its session id on stdin to hook commands — its MCP stdio
 * children get a scrubbed environment with no session variable — so the
 * session-start context tells the model which `agent_id` to pass on writes.
 *
 * Vibe's hook contract is snake_case: exit 0 with
 * `{"hook_specific_output":{"additional_context": …}}` on stdout, which is
 * the only channel that reaches the model (plain stdout is ignored — verified
 * on Vibe 3.1.3). The other lifecycle events ride the harness-agnostic
 * `concord inbox` commands instead: `pre_agent` and `post_tool` drain with the
 * `vibe` format, `post_agent` and `notification` observe.
 */
export const VIBE_HOOK_EVENTS = ['vibe-session-start', 'vibe-session-end'] as const;
export type VibeHookEvent = (typeof VIBE_HOOK_EVENTS)[number];

export function isVibeHookEvent(event: string): event is VibeHookEvent {
  return VIBE_HOOK_EVENTS.some((known) => known === event);
}

const NO_OUTPUT = '{}';

/** Vibe's hook payloads always carry `cwd`; it is also the project root. */
const vibeProjectPayloadSchema = z.object({ cwd: z.string().optional() }).loose();

function vibeRepoRoot(rawJson: string, fallback: string = process.cwd()): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return fallback;
  }
  const payload = vibeProjectPayloadSchema.safeParse(parsed);
  if (!payload.success) return fallback;
  const dir = payload.data.cwd;
  return dir === undefined || dir.trim() === '' ? fallback : dir;
}

export function vibeSessionStartOutput(agentId: string, others: readonly RosterLine[]): string {
  return JSON.stringify({
    hook_specific_output: {
      additional_context: sessionStartMessage(agentId, others, VIBE_SESSION_IDENTITY),
    },
  });
}

function endVibeSession(repos: Repositories, agentId: string): void {
  const endpoint = repos.agentEndpoints.getByAgent(agentId);
  if (endpoint !== undefined) repos.agentEndpoints.disconnect(endpoint.endpointId);
}

export function handleLocalVibeHook(
  repos: Repositories,
  identity: AgentIdentity,
  repoRoot: string,
  event: VibeHookEvent,
  rawJson: string,
): string {
  switch (event) {
    case 'vibe-session-start':
      ensureAgentRegistered(repos, identity, repoRoot);
      registerPullEndpoint(repos, identity.agentId, 'vibe');
      // Same bookkeeping the inbox hooks do: a fresh session requeues what an
      // earlier one was handed but never showed, and clears the await-user flag.
      observeHookEvent(repos, identity.agentId, rawJson);
      return vibeSessionStartOutput(
        identity.agentId,
        buildRoster(repos.agents.list(), Date.now()).filter(
          (peer) => peer.agentId !== identity.agentId,
        ),
      );
    case 'vibe-session-end':
      // Read evidence and unread requeue first, then release the endpoint:
      // a session that ended will never read what it was handed but did not
      // show, so those messages go back to the queue for the next session.
      observeHookEvent(repos, identity.agentId, rawJson);
      endVibeSession(repos, identity.agentId);
      return NO_OUTPUT;
  }
}

/**
 * The cloud has no endpoint disconnect: presence there lapses with
 * `last_seen`, and messages wait for the next session either way, so
 * session end is a no-op there.
 */
async function handleCloudVibeHook(
  runtime: CloudRuntime,
  identity: AgentIdentity,
  cwd: string,
  event: VibeHookEvent,
): Promise<string> {
  switch (event) {
    case 'vibe-session-start':
      await registerInCloud(runtime, identity.agentId, 'vibe', cwd);
      return vibeSessionStartOutput(identity.agentId, await cloudRoster(runtime, identity.agentId));
    case 'vibe-session-end':
      return NO_OUTPUT;
  }
}

/**
 * Never blocks the Vibe session: an unidentifiable payload or an unreachable
 * cloud yields no context (and a note on stderr), not a failed hook.
 */
export async function runVibeHook(
  event: VibeHookEvent,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  // A spawned subagent's hooks carry parent_session_id. Registering one would
  // advertise a peer whose own delivery hooks Concord ignores, so messages
  // sent to it could never arrive; its payloads get no Concord context.
  const hook = parseObservedHook(rawJson);
  if (hook !== undefined && isSubagentHook(hook)) return NO_OUTPUT;
  const identity = resolveIdentity(env, { kind: 'vibe', hookPayload: rawJson });
  if (identity === undefined) return NO_OUTPUT;
  const repoRoot = vibeRepoRoot(rawJson);
  // Vibe inherits its launcher's environment, which can carry a stale
  // CLAUDE_PROJECT_DIR or CONCORD_REPO_ROOT pointing at another checkout;
  // pin the payload's cwd the way Kiro and Hermes do.
  const projectEnv = { ...env, CONCORD_REPO_ROOT: repoRoot };
  const access = cloudAccess(repoRoot, { timeoutMs: HOOK_TIMEOUT_MS }, projectEnv);
  if (access.kind === 'unusable') {
    process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
    return NO_OUTPUT;
  }
  if (access.kind === 'local') {
    const { openContext } = await import('../context.js');
    return handleLocalVibeHook(
      openContext(repoRoot, projectEnv).repos,
      identity,
      repoRoot,
      event,
      rawJson,
    );
  }
  try {
    return await handleCloudVibeHook(access.runtime, identity, repoRoot, event);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Concord Cloud could not be reached: ${detail}\n`);
    return NO_OUTPUT;
  }
}
