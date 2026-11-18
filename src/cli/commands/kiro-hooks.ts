import { z } from 'zod';

import type { CloudRuntime } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import {
  resolveIdentity,
  UNRESOLVED_IDENTITY_MESSAGE,
  type AgentIdentity,
} from '../../domain/identity.js';
import { buildRoster } from '../../domain/presence.js';
import { renderInboxBody, type DeliverableMessage } from '../../domain/pull-inbox.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { openContext } from '../context.js';
import { cloudRoster } from './cloud-hooks.js';
import { cloudAccess, drainFromCloud, HOOK_TIMEOUT_MS, registerInCloud } from './cloud-inbox.js';
import { drainInbox, registerPullEndpoint } from './inbox.js';
import { kiroSessionStartMessage, type RosterLine } from './session-start-message.js';

/**
 * Kiro lifecycle hooks (`.kiro/hooks/concord.json`). Kiro writes the event
 * payload, including `session_id`, to stdin and adds a hook's stdout to the
 * agent context, so SessionStart prints the identity and the write conventions
 * while prompt-submit and stop print pending peer messages. In a repository
 * linked to Concord Cloud the session registers and drains there instead.
 */

export const KIRO_HOOK_EVENTS = [
  'kiro-session-start',
  'kiro-user-prompt-submit',
  'kiro-stop',
] as const;
export type KiroHookEvent = (typeof KIRO_HOOK_EVENTS)[number];

export function isKiroHookEvent(event: string): event is KiroHookEvent {
  return KIRO_HOOK_EVENTS.some((known) => known === event);
}

/** Kiro adds stdout to the context; an empty string adds nothing. */
const NO_OUTPUT = '';

const kiroPayloadSchema = z
  .object({
    session_id: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

/** The workspace a Kiro hook runs for: its payload's `cwd`, else this process's. */
export function kiroWorkspace(rawJson: string): string {
  try {
    const parsed = kiroPayloadSchema.safeParse(JSON.parse(rawJson));
    const cwd = parsed.success ? parsed.data.cwd?.trim() : undefined;
    return cwd === undefined || cwd === '' ? process.cwd() : cwd;
  } catch {
    return process.cwd();
  }
}

function promptSubmitOutput(messages: readonly DeliverableMessage[]): string {
  return messages.length === 0 ? NO_OUTPUT : renderInboxBody(messages);
}

function sessionStartOutput(agentId: string, others: readonly RosterLine[]): string {
  return kiroSessionStartMessage(agentId, others);
}

export function handleLocalKiroHook(
  repos: Repositories,
  identity: AgentIdentity,
  repoRoot: string,
  event: KiroHookEvent,
): string {
  switch (event) {
    case 'kiro-session-start':
      ensureAgentRegistered(repos, identity, repoRoot);
      registerPullEndpoint(repos, identity.agentId, 'kiro');
      return sessionStartOutput(
        identity.agentId,
        buildRoster(repos.agents.list(), Date.now()).filter(
          (peer) => peer.agentId !== identity.agentId,
        ),
      );
    case 'kiro-user-prompt-submit':
    case 'kiro-stop':
      return promptSubmitOutput(drainInbox(repos, identity.agentId, 'kiro'));
  }
}

export async function handleCloudKiroHook(
  runtime: CloudRuntime,
  identity: AgentIdentity,
  cwd: string,
  event: KiroHookEvent,
): Promise<string> {
  switch (event) {
    case 'kiro-session-start':
      await registerInCloud(runtime, identity.agentId, 'kiro', cwd);
      return sessionStartOutput(identity.agentId, await cloudRoster(runtime, identity.agentId));
    case 'kiro-user-prompt-submit':
    case 'kiro-stop':
      return promptSubmitOutput(await drainFromCloud(runtime, identity.agentId, 'kiro'));
  }
}

/**
 * Never blocks the Kiro session: an unidentifiable payload or an unreachable
 * cloud yields no context (and a note on stderr), not a failed hook.
 */
export async function runKiroHook(
  event: KiroHookEvent,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const identity = resolveIdentity(env, { kind: 'kiro', hookPayload: rawJson });
  if (identity === undefined) {
    return event === 'kiro-session-start' ? `Concord: ${UNRESOLVED_IDENTITY_MESSAGE}` : NO_OUTPUT;
  }
  const repoRoot = kiroWorkspace(rawJson);
  const access = cloudAccess(repoRoot, { timeoutMs: HOOK_TIMEOUT_MS }, env);
  if (access.kind === 'unusable') {
    process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
    return NO_OUTPUT;
  }
  if (access.kind === 'local') {
    return handleLocalKiroHook(openContext(repoRoot, env).repos, identity, repoRoot, event);
  }
  try {
    return await handleCloudKiroHook(access.runtime, identity, repoRoot, event);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Concord Cloud could not be reached: ${detail}\n`);
    return NO_OUTPUT;
  }
}
