import type { CloudRuntime } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import type { AgentIdentity } from '../../domain/identity.js';
import type { DeliverableMessage } from '../../domain/pull-inbox.js';
import { createHarnessHooks } from './harness-hooks.js';
import { DEVIN_SESSION_IDENTITY, type RosterLine } from './session-start-message.js';

/**
 * Devin CLI lifecycle hooks (`.devin/hooks.v1.json`). Devin passes its session
 * id on stdin to hook commands, never to the MCP server, so the session-start
 * context tells the model which agent_id to pass on writes. The shared runner
 * in `harness-hooks.ts` does the work; this file only names Devin's events and
 * project-dir source (`DEVIN_PROJECT_DIR`, which Devin sets to the hook's
 * project root).
 */

export const DEVIN_HOOK_EVENTS = [
  'devin-session-start',
  'devin-user-prompt-submit',
  'devin-session-end',
] as const;
export type DevinHookEvent = (typeof DEVIN_HOOK_EVENTS)[number];

const hooks = createHarnessHooks({
  kind: 'devin',
  sessionIdentity: DEVIN_SESSION_IDENTITY,
  repoRoot: (env) => env['DEVIN_PROJECT_DIR'] ?? process.cwd(),
});

export function isDevinHookEvent(event: string): event is DevinHookEvent {
  return DEVIN_HOOK_EVENTS.some((known) => known === event);
}

export function devinSessionStartOutput(agentId: string, others: readonly RosterLine[]): string {
  return hooks.sessionStartOutput(agentId, others);
}

export function devinPromptSubmitOutput(messages: readonly DeliverableMessage[]): string {
  return hooks.promptSubmitOutput(messages);
}

export function endDevinSession(repos: Repositories, agentId: string): void {
  hooks.endSession(repos, agentId);
}

export function handleLocalDevinHook(
  repos: Repositories,
  identity: AgentIdentity,
  repoRoot: string,
  event: DevinHookEvent,
): string {
  return hooks.handleLocalHook(repos, identity, repoRoot, event);
}

export function handleCloudDevinHook(
  runtime: CloudRuntime,
  identity: AgentIdentity,
  cwd: string,
  event: DevinHookEvent,
): Promise<string> {
  return hooks.handleCloudHook(runtime, identity, cwd, event);
}

export function runDevinHook(
  event: DevinHookEvent,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return hooks.run(event, rawJson, env);
}
