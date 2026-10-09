import { readFileSync } from 'node:fs';

import type { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

import type { Repositories } from '../../db/index.js';
import { resolveIdentity, UNRESOLVED_IDENTITY_MESSAGE } from '../../domain/identity.js';
import { buildRoster } from '../../domain/presence.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import type { TelemetryRecorder } from '../../telemetry/events.js';
import { sessionStartIdentity } from '../agent-identity.js';
import { openContext } from '../context.js';
import { checkFileOverlaps } from './check.js';
import { decideCloudPreToolUse, handleCloudSessionStart } from './cloud-hooks.js';
import { cloudAccess, HOOK_TIMEOUT_MS } from './cloud-inbox.js';
import { registerPullEndpoint } from './inbox.js';
import { sessionStartMessage } from './session-start-message.js';
import type { CloudRuntime } from '../../cloud/runtime.js';

/** The subset of Claude Code's PreToolUse payload we need: the edited file path.
 * Everything else is passed through and ignored. */
const preToolUsePayloadSchema = z
  .object({
    tool_input: z.object({ file_path: z.string().optional() }).loose().optional(),
  })
  .loose();

export interface HookDecision {
  /** True → deny the tool call (exit 2). */
  block: boolean;
  /** Message for stderr (shown to the agent); empty when there is nothing to say. */
  message: string;
  result: 'not_applicable' | 'clear' | 'warned' | 'blocked';
  conflictingTaskCount: number;
}

/**
 * Decide whether a Claude Code PreToolUse event (Edit/Write/MultiEdit) should be
 * blocked because the edited file is claimed by another active task.
 *
 * `selfTaskId` (from `$CONCORD_TASK`) excludes your own claim. Without it we
 * cannot tell your own files apart from a real conflict, so we advise but never
 * block — blocking an agent from editing its own claimed files would be worse
 * than the problem this guards against.
 */
export function decidePreToolUse(
  repos: Repositories,
  rawJson: string,
  selfTaskId?: string,
): HookDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { block: false, message: '', result: 'not_applicable', conflictingTaskCount: 0 };
  }
  const payload = preToolUsePayloadSchema.parse(parsed);
  const filePath = payload.tool_input?.file_path;
  if (filePath === undefined || filePath === '') {
    return { block: false, message: '', result: 'not_applicable', conflictingTaskCount: 0 };
  }

  const overlaps = checkFileOverlaps(repos, [filePath], selfTaskId);
  if (overlaps.length === 0) {
    return { block: false, message: '', result: 'clear', conflictingTaskCount: 0 };
  }

  const detail = overlaps.map((overlap) => `${overlap.taskId} (${overlap.title})`).join(', ');
  if (selfTaskId === undefined) {
    return {
      block: false,
      message: `Concord: ${filePath} is also claimed by ${detail}. Set CONCORD_TASK=<your task id> to block colliding edits.`,
      result: 'warned',
      conflictingTaskCount: overlaps.length,
    };
  }
  return {
    block: true,
    message: `Concord: ${filePath} is claimed by another active task (${detail}). Coordinate or update your claim before editing.`,
    result: 'blocked',
    conflictingTaskCount: overlaps.length,
  };
}

/** The subset of Claude Code's SessionStart payload we use. */
const sessionStartPayloadSchema = z
  .object({
    session_id: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

export { sessionStartIdentity };

export interface SessionStartResult {
  /** Undefined when no session id was available to derive an identity from. */
  agentId: string | undefined;
  /** Context printed to stdout, which Claude Code injects into the session. */
  message: string;
}

/**
 * Register this Claude Code session before — or even if — the model calls
 * `start_work`, then tell it the `agent_id` and who else is active. Reads a
 * SessionStart JSON payload.
 */
export function handleSessionStart(
  repos: Repositories,
  rawJson: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionStartResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = {};
  }
  const payload = sessionStartPayloadSchema.parse(parsed);
  // A malformed payload still has the environment to fall back on, since the
  // hook runs inside the session it is describing.
  const identity = sessionStartIdentity(payload.session_id, env);
  if (identity === undefined) {
    return { agentId: undefined, message: `Concord: ${UNRESOLVED_IDENTITY_MESSAGE}` };
  }
  const agentId = identity.agentId;

  ensureAgentRegistered(repos, identity, payload.cwd ?? null);

  // Advertise the session as reachable before any tool call, so a peer that
  // messages it early gets its message queued rather than rejected.
  registerPullEndpoint(repos, agentId, identity.kind);

  const others = buildRoster(repos.agents.list(), Date.now()).filter(
    (entry) => entry.agentId !== agentId,
  );
  return { agentId, message: sessionStartMessage(agentId, others) };
}

/** Read piped stdin to a string. Returns '' when attached to a TTY (no input). */
function readStdin(): string {
  if (process.stdin.isTTY) {
    return '';
  }
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function registerHookCommand(program: Command, telemetry?: TelemetryRecorder): void {
  program
    .command('hook <event>')
    .description(
      'Run a Concord hook. events: pre-tool-use (PreToolUse overlap gate) and ' +
        'session-start (SessionStart presence auto-register); both read a Claude Code JSON ' +
        'payload on stdin.',
    )
    .action(async (event) => {
      const access = cloudAccess(process.cwd(), { timeoutMs: HOOK_TIMEOUT_MS });
      if (access.kind === 'unusable') {
        // Never a local workspace in its place, and never a blocked edit or session.
        process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
        return;
      }
      if (access.kind === 'cloud') {
        await runCloudHook(access.runtime, event);
        return;
      }
      if (event === 'session-start') {
        const result = handleSessionStart(openContext(process.cwd()).repos, readStdin());
        process.stdout.write(`${result.message}\n`);
        return;
      }
      if (event !== 'pre-tool-use') {
        process.stderr.write(`Unknown hook event: ${event}\n`);
        process.exitCode = 1;
        return;
      }
      const decision = decidePreToolUse(
        openContext(process.cwd()).repos,
        readStdin(),
        process.env['CONCORD_TASK'],
      );
      if (decision.result !== 'not_applicable') {
        const taskId = process.env['CONCORD_TASK'];
        telemetry?.recordEvent({
          event_type: 'edit_guard_evaluated',
          task_flow_id: taskId === undefined ? null : telemetry.taskPseudonym(taskId),
          result: decision.result,
          conflicting_task_count: decision.conflictingTaskCount,
        });
      }
      if (decision.message !== '') {
        process.stderr.write(`${decision.message}\n`);
      }
      if (decision.block) {
        // Claude Code treats PreToolUse exit code 2 as "deny the tool call".
        process.exitCode = 2;
      }
    });
}

/**
 * A hook in a repository linked to Concord Cloud. Neither may break the
 * session: a cloud that cannot be reached is said once, and the edit or the
 * session goes ahead.
 */
async function runCloudHook(runtime: CloudRuntime, event: string): Promise<void> {
  if (event === 'session-start') {
    const message = await handleCloudSessionStart(runtime, readStdin()).then(
      (result) => result.message,
      (error: unknown) =>
        `Concord Cloud could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.stdout.write(`${message}\n`);
    return;
  }
  if (event !== 'pre-tool-use') {
    process.stderr.write(`Unknown hook event: ${event}\n`);
    process.exitCode = 1;
    return;
  }
  const decision = await decideCloudPreToolUse(
    runtime,
    readStdin(),
    process.env['CONCORD_TASK'],
    resolveIdentity(process.env, { kind: 'claude-code' })?.agentId,
  );
  if (decision.message !== '') process.stderr.write(`${decision.message}\n`);
  // Claude Code treats PreToolUse exit code 2 as "deny the tool call".
  if (decision.block) process.exitCode = 2;
}
