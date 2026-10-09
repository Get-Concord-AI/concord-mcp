import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { repoRelative } from '../../cloud/proxy.js';
import {
  listClaims,
  listCloudAgents,
  type CloudClaim,
  type CloudRuntime,
} from '../../cloud/runtime.js';
import { UNRESOLVED_IDENTITY_MESSAGE } from '../../domain/identity.js';
import { deriveLiveness } from '../../domain/presence.js';
import { sessionStartIdentity } from '../agent-identity.js';
import { registerInCloud } from './cloud-inbox.js';
import type { HookDecision, SessionStartResult } from './hook.js';
import { sessionStartMessage } from './session-start-message.js';

/**
 * The Claude Code hooks in a repository linked to Concord Cloud: the edit
 * guard asks the cloud who holds a file, and session start registers there and
 * names everyone in the organization, on any machine.
 *
 * Neither records telemetry: these are not local operations.
 */

const preToolUsePayloadSchema = z
  .object({
    tool_input: z.object({ file_path: z.string().optional() }).loose().optional(),
  })
  .loose();

/**
 * The guard runs before every edit, and Cloud Run may be starting from zero:
 * past this, the edit goes ahead with a warning rather than stalling.
 */
const GUARD_TIMEOUT_MS = 3_000;

const NOT_APPLICABLE: HookDecision = {
  block: false,
  message: '',
  result: 'not_applicable',
  conflictingTaskCount: 0,
};

/**
 * The local guard's rule, over the cloud's claims: another task holding the
 * file blocks the edit when `CONCORD_TASK` names the caller's own task, and
 * warns otherwise. Claims held by this session's own agent are never a
 * conflict — the cloud says who holds each one, which the local check cannot.
 */
export async function decideCloudPreToolUse(
  runtime: CloudRuntime,
  rawJson: string,
  selfTaskId: string | undefined,
  selfAgentKey: string | undefined,
): Promise<HookDecision> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return NOT_APPLICABLE;
  }
  const filePath = preToolUsePayloadSchema.parse(parsed).tool_input?.file_path;
  if (filePath === undefined || filePath === '') return NOT_APPLICABLE;
  const file = repoRelative(runtime, filePath);
  // Outside this repository: nothing the project's claims could cover.
  if (isAbsolute(file)) return NOT_APPLICABLE;

  let claims: readonly CloudClaim[];
  try {
    claims = await listClaims(runtime, [file], AbortSignal.timeout(GUARD_TIMEOUT_MS));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      block: false,
      message: `Concord: could not check ${file} against Concord Cloud (${detail}); editing anyway.`,
      result: 'not_applicable',
      conflictingTaskCount: 0,
    };
  }

  const others = claims.filter(
    (claim) =>
      claim.taskKey !== selfTaskId &&
      (selfAgentKey === undefined || claim.agentKey !== selfAgentKey),
  );
  if (others.length === 0) {
    return { block: false, message: '', result: 'clear', conflictingTaskCount: 0 };
  }
  const tasks = [...new Map(others.map((claim) => [claim.taskKey, claim])).values()];
  const detail = tasks
    .map((claim) => `${claim.taskKey} (${claim.title}, ${claim.agentKey ?? 'unassigned'})`)
    .join(', ');
  if (selfTaskId === undefined) {
    return {
      block: false,
      message: `Concord: ${file} is also claimed by ${detail}. Set CONCORD_TASK=<your task id> to block colliding edits.`,
      result: 'warned',
      conflictingTaskCount: tasks.length,
    };
  }
  return {
    block: true,
    message: `Concord: ${file} is claimed by another active task (${detail}). Coordinate or update your claim before editing.`,
    result: 'blocked',
    conflictingTaskCount: tasks.length,
  };
}

const sessionStartPayloadSchema = z
  .object({ session_id: z.string().optional(), cwd: z.string().optional() })
  .loose();

/** Session start in a linked repository: registered in the cloud, and told who else is there. */
export async function handleCloudSessionStart(
  runtime: CloudRuntime,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionStartResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = {};
  }
  const payload = sessionStartPayloadSchema.parse(parsed);
  const identity = sessionStartIdentity(payload.session_id, env);
  if (identity === undefined) {
    return { agentId: undefined, message: `Concord: ${UNRESOLVED_IDENTITY_MESSAGE}` };
  }
  await registerInCloud(runtime, identity.agentId, identity.kind, payload.cwd ?? process.cwd());
  const now = Date.now();
  const others = (await listCloudAgents(runtime))
    .filter((agent) => agent.agentKey !== identity.agentId)
    .map((agent) => ({
      agentId: agent.agentKey,
      liveness: deriveLiveness(agent.lastSeenAt, now),
      status: agent.status,
      summary: agent.summary,
    }))
    .filter((peer) => peer.liveness !== 'archived');
  return { agentId: identity.agentId, message: sessionStartMessage(identity.agentId, others) };
}
