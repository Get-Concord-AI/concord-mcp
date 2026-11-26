import { z } from 'zod';

import type { CloudRuntime } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import type { AgentIdentity } from '../../domain/identity.js';
import type { DeliverableMessage } from '../../domain/pull-inbox.js';
import { createHarnessHooks } from './harness-hooks.js';
import { JUNIE_SESSION_IDENTITY, type RosterLine } from './session-start-message.js';

/**
 * Junie CLI lifecycle hooks (`~/.junie/config.json`). Junie passes its session
 * id on stdin to hook commands — there is no `JUNIE_SESSION_ID` env var — and
 * its SessionEnd payload carries only `reason`, so that event cannot resolve
 * an identity. In a repository linked to Concord Cloud the session registers
 * and drains there, as every other hook does. The shared runner in
 * `harness-hooks.ts` does the work; this file only names Junie's events and
 * its project-dir source (`project_path`/`cwd` from the payload).
 */

export const JUNIE_HOOK_EVENTS = [
  'junie-session-start',
  'junie-user-prompt-submit',
  'junie-session-end',
] as const;
export type JunieHookEvent = (typeof JUNIE_HOOK_EVENTS)[number];

/**
 * The fields Junie's hook payloads carry for repository resolution
 * (https://junie.jetbrains.com/docs/junie-cli-hooks.html): `project_path` is
 * the project root and `cwd` the working directory, on SessionStart and
 * UserPromptSubmit. SessionEnd sends only `reason`, so it yields neither.
 */
const junieProjectPayloadSchema = z
  .object({
    project_path: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

/**
 * The repo root a Junie hook works in: the payload's `project_path`, then its
 * `cwd`, then the process cwd — a `--project /elsewhere` session started from
 * another directory still registers in the right repo.
 */
export function junieRepoRoot(rawJson: string, fallback: string = process.cwd()): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return fallback;
  }
  const payload = junieProjectPayloadSchema.safeParse(parsed);
  if (!payload.success) return fallback;
  const dir = payload.data.project_path ?? payload.data.cwd;
  return dir === undefined || dir.trim() === '' ? fallback : dir;
}

const hooks = createHarnessHooks({
  kind: 'junie',
  sessionIdentity: JUNIE_SESSION_IDENTITY,
  repoRoot: (_env, rawJson) => junieRepoRoot(rawJson),
  // Junie ignores SessionStart's additionalContext outright (documented hook
  // limitation), so the identity briefing rides the first UserPromptSubmit —
  // the one event whose context always reaches the model.
  briefOnFirstPrompt: true,
});

export function isJunieHookEvent(event: string): event is JunieHookEvent {
  return JUNIE_HOOK_EVENTS.some((known) => known === event);
}

export function junieSessionStartOutput(agentId: string, others: readonly RosterLine[]): string {
  return hooks.sessionStartOutput(agentId, others);
}

export function juniePromptSubmitOutput(messages: readonly DeliverableMessage[]): string {
  return hooks.promptSubmitOutput(messages);
}

export function endJunieSession(repos: Repositories, agentId: string): void {
  hooks.endSession(repos, agentId);
}

export function handleLocalJunieHook(
  repos: Repositories,
  identity: AgentIdentity,
  repoRoot: string,
  event: JunieHookEvent,
  env: NodeJS.ProcessEnv = process.env,
  sessionId?: string,
): string {
  return hooks.handleLocalHook(repos, identity, repoRoot, event, env, sessionId);
}

export function handleCloudJunieHook(
  runtime: CloudRuntime,
  identity: AgentIdentity,
  cwd: string,
  event: JunieHookEvent,
  env: NodeJS.ProcessEnv = process.env,
  sessionId?: string,
): Promise<string> {
  return hooks.handleCloudHook(runtime, identity, cwd, event, env, sessionId);
}

export function runJunieHook(
  event: JunieHookEvent,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return hooks.run(event, rawJson, env);
}
