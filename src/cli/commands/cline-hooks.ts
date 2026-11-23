import { z } from 'zod';

import type { CloudRuntime } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import {
  agentIdForSession,
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
import { clineSessionStartMessage, type RosterLine } from './session-start-message.js';

/**
 * Cline lifecycle hooks (`~/Documents/Cline/Hooks` and `~/.cline/hooks`). Cline
 * writes the event payload — `task_id`, `workspace_roots`, `hook_name` — to
 * stdin and reads a JSON control object back on stdout, whose
 * `contextModification` field is added to the model's context. The VS Code
 * extension honors that output; the CLI's SDK path runs hooks detached and
 * ignores it, so prompt-submit drains only for payloads the extension
 * produced — a drain marks messages delivered, and delivering nothing would
 * lose them. Task start/resume always register presence and emit the
 * identity: side effects need no stdout, and the output is a bonus where the
 * surface shows it.
 *
 * Cline has one global MCP settings file, no `${workspaceFolder}` expansion,
 * and no MCP roots capability, so the MCP server cannot see which workspace
 * is open. The hook knows `workspace_roots`, so it names the `workspace_id`
 * the agent must pass, and derives a stable `cline:<hash(task_id)>` identity.
 * In a repository linked to Concord Cloud the session registers and drains
 * there instead.
 */

export const CLINE_HOOK_EVENTS = [
  'cline-task-start',
  'cline-task-resume',
  'cline-user-prompt-submit',
] as const;
export type ClineHookEvent = (typeof CLINE_HOOK_EVENTS)[number];

export function isClineHookEvent(event: string): event is ClineHookEvent {
  return CLINE_HOOK_EVENTS.some((known) => known === event);
}

const clinePayloadSchema = z
  .object({
    task_id: z.string().optional(),
    taskId: z.string().optional(),
    hook_name: z.string().optional(),
    hookName: z.string().optional(),
    workspace_roots: z.array(z.string()).optional(),
    workspaceRoots: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  })
  .loose();

type ClinePayload = z.infer<typeof clinePayloadSchema>;

function parsePayload(rawJson: string): ClinePayload {
  try {
    const parsed = clinePayloadSchema.safeParse(JSON.parse(rawJson));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function taskIdOf(payload: ClinePayload): string | undefined {
  const taskId = payload.taskId ?? payload.task_id;
  const trimmed = taskId?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Which Cline surface produced the payload. The VS Code extension names hooks
 * with its event types (`UserPromptSubmit`); the SDK/CLI names them with its
 * own (`prompt_submit`, `agent_start`). Only the extension's output reaches
 * the model, which is what makes a prompt-submit drain safe.
 */
export type ClineSurface = 'extension' | 'sdk' | 'unknown';

const EXTENSION_HOOK_NAMES: ReadonlySet<string> = new Set([
  'taskstart',
  'taskresume',
  'taskcancel',
  'taskcomplete',
  'pretooluse',
  'posttooluse',
  'userpromptsubmit',
  'notification',
  'precompact',
]);

const SDK_HOOK_NAMES: ReadonlySet<string> = new Set([
  'agentstart',
  'agentresume',
  'agentcancel',
  'agentcomplete',
  'agentstop',
  'promptsubmit',
]);

function normalizeHookName(payload: ClinePayload): string {
  return (payload.hookName ?? payload.hook_name ?? '')
    .toLowerCase()
    .replace(/[^a-z]/gu, '');
}

export function clineSurface(payload: ClinePayload): ClineSurface {
  const name = normalizeHookName(payload);
  if (EXTENSION_HOOK_NAMES.has(name)) return 'extension';
  if (SDK_HOOK_NAMES.has(name)) return 'sdk';
  return 'unknown';
}

/** The workspace a Cline hook runs for: its payload's first workspace root, else cwd. */
export function clineWorkspace(rawJson: string): string {
  const payload = parsePayload(rawJson);
  const roots = payload.workspaceRoots ?? payload.workspace_roots;
  const root = roots?.find((candidate) => candidate.trim() !== '');
  if (root !== undefined) return root;
  const cwd = payload.cwd?.trim();
  return cwd === undefined || cwd === '' ? process.cwd() : cwd;
}

/**
 * `CONCORD_AGENT_ID` stays authoritative; otherwise the task id — stable for
 * the life of a Cline task, including resumes — derives the session identity.
 */
function clineIdentity(
  payload: ClinePayload,
  env: NodeJS.ProcessEnv,
): AgentIdentity | undefined {
  const resolved = resolveIdentity(env, { kind: 'cline' });
  if (resolved !== undefined) return resolved;
  const taskId = taskIdOf(payload);
  if (taskId === undefined) return undefined;
  return { agentId: agentIdForSession('cline', taskId), kind: 'cline', origin: 'hook' };
}

/** Cline reads a JSON control object; `contextModification` is added to context. */
function hookOutput(contextModification: string | undefined): string {
  if (contextModification === undefined || contextModification === '') return '{}';
  return JSON.stringify({ contextModification });
}

function inboxOutput(messages: readonly DeliverableMessage[]): string {
  return hookOutput(messages.length === 0 ? undefined : renderInboxBody(messages));
}

function rosterOthers(
  repos: Repositories,
  agentId: string,
): RosterLine[] {
  return buildRoster(repos.agents.list(), Date.now()).filter(
    (peer) => peer.agentId !== agentId,
  );
}

export function handleLocalClineHook(
  repos: Repositories,
  identity: AgentIdentity,
  context: { repoRoot: string; workspaceId: string },
  event: ClineHookEvent,
  surface: ClineSurface,
): string {
  switch (event) {
    case 'cline-task-start':
    case 'cline-task-resume':
      ensureAgentRegistered(repos, identity, context.repoRoot);
      registerPullEndpoint(repos, identity.agentId, 'cline');
      return hookOutput(
        clineSessionStartMessage(identity.agentId, context.workspaceId, rosterOthers(repos, identity.agentId)),
      );
    case 'cline-user-prompt-submit':
      // Only the extension's prompt-submit output reaches the model for sure.
      // The SDK runs hooks detached, so draining there would mark messages
      // delivered that no session ever sees; instead the endpoint is
      // refreshed and a pending-count notice is emitted — harmless where the
      // output is ignored, a drain hint where it is shown.
      if (surface !== 'extension') {
        registerPullEndpoint(repos, identity.agentId, 'cline');
        const pending = repos.agentMessages.listPendingForRecipient(identity.agentId).length;
        return pending === 0
          ? '{}'
          : hookOutput(
              `${String(pending)} Concord message(s) wait in your inbox. ` +
                `Run \`concord inbox drain --agent ${identity.agentId} --provider cline\` to read them.`,
            );
      }
      return inboxOutput(drainInbox(repos, identity.agentId, 'cline'));
  }
}

export async function handleCloudClineHook(
  runtime: CloudRuntime,
  identity: AgentIdentity,
  cwd: string,
  event: ClineHookEvent,
  surface: ClineSurface,
): Promise<string> {
  switch (event) {
    case 'cline-task-start':
    case 'cline-task-resume':
      await registerInCloud(runtime, identity.agentId, 'cline', cwd);
      return hookOutput(
        clineSessionStartMessage(
          identity.agentId,
          undefined,
          await cloudRoster(runtime, identity.agentId),
        ),
      );
    case 'cline-user-prompt-submit':
      if (surface !== 'extension') {
        await registerInCloud(runtime, identity.agentId, 'cline', cwd);
        return '{}';
      }
      return inboxOutput(await drainFromCloud(runtime, identity.agentId, 'cline'));
  }
}

/**
 * Never blocks the Cline session: an unidentifiable payload or an unreachable
 * cloud yields an empty control object (and a note on stderr), not a failed
 * hook — a failed hook could cancel the user's task.
 */
export async function runClineHook(
  event: ClineHookEvent,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const payload = parsePayload(rawJson);
  const surface = clineSurface(payload);
  const identity = clineIdentity(payload, env);
  if (identity === undefined) {
    return event === 'cline-user-prompt-submit'
      ? '{}'
      : hookOutput(`Concord: ${UNRESOLVED_IDENTITY_MESSAGE}`);
  }
  const repoRoot = clineWorkspace(rawJson);
  // The payload's workspace is the project, whatever this process inherited:
  // a CLAUDE_PROJECT_DIR or DEVIN_PROJECT_DIR from the shell that launched
  // Cline names another repository.
  const projectEnv = { ...env, CONCORD_REPO_ROOT: repoRoot };
  const access = cloudAccess(repoRoot, { timeoutMs: HOOK_TIMEOUT_MS }, projectEnv);
  if (access.kind === 'unusable') {
    process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
    return '{}';
  }
  if (access.kind === 'local') {
    const context = openContext(repoRoot, projectEnv);
    return handleLocalClineHook(
      context.repos,
      identity,
      { repoRoot: context.repoRoot, workspaceId: context.workspaceId },
      event,
      surface,
    );
  }
  try {
    return await handleCloudClineHook(access.runtime, identity, repoRoot, event, surface);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Concord Cloud could not be reached: ${detail}\n`);
    return '{}';
  }
}
