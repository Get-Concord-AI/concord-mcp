import type { CloudRuntime } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import type { AgentIdentity } from '../../domain/identity.js';
import type { DeliverableMessage } from '../../domain/pull-inbox.js';
import { createHarnessHooks } from './harness-hooks.js';
import { JUNIE_SESSION_IDENTITY, type RosterLine } from './session-start-message.js';

/**
 * Junie CLI lifecycle hooks (`~/.junie/config.json`). Junie passes its session
 * id on stdin to hook commands. In a repository linked to Concord Cloud the
 * session registers and drains there, as every other hook does. The shared
 * runner in `harness-hooks.ts` does the work; this file only names Junie's
 * events and project-dir source (`JUNIE_PROJECT_DIR`).
 */

export const JUNIE_HOOK_EVENTS = [
  'junie-session-start',
  'junie-user-prompt-submit',
  'junie-session-end',
] as const;
export type JunieHookEvent = (typeof JUNIE_HOOK_EVENTS)[number];

const hooks = createHarnessHooks({
  kind: 'junie',
  sessionIdentity: JUNIE_SESSION_IDENTITY,
  repoRoot: (env) => env['JUNIE_PROJECT_DIR'] ?? process.cwd(),
});

export function isJunieHookEvent(event: string): event is JunieHookEvent {
  return JUNIE_HOOK_EVENTS.some((known) => known === event);
}

export function junieSessionStartOutput(
  agentId: string,
  others: readonly RosterLine[],
): string {
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
): string {
  return hooks.handleLocalHook(repos, identity, repoRoot, event);
}

export function handleCloudJunieHook(
  runtime: CloudRuntime,
  identity: AgentIdentity,
  cwd: string,
  event: JunieHookEvent,
): Promise<string> {
  return hooks.handleCloudHook(runtime, identity, cwd, event);
}

export function runJunieHook(
  event: JunieHookEvent,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return hooks.run(event, rawJson, env);
}
