import { readFileSync } from 'node:fs';

import type { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

import type { Repositories } from '../../db/index.js';
import {
  agentIdForSession,
  hookSessionId,
  resolveIdentity,
  UNRESOLVED_IDENTITY_MESSAGE,
} from '../../domain/identity.js';
import {
  antigravityInjectSteps,
  antigravityMonitorNudge,
} from '../../domain/antigravity-monitor.js';
import { receiverActive } from '../../domain/delivery.js';
import { renderInboxBody, type DeliverableMessage } from '../../domain/pull-inbox.js';
import { sessionKey } from '../../domain/receipts.js';
import { buildRoster } from '../../domain/presence.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import type { TelemetryRecorder } from '../../telemetry/events.js';
import { sessionStartIdentity } from '../agent-identity.js';
import { openContext } from '../context.js';
import { checkFileOverlaps } from './check.js';
import {
  decideCloudPreToolUse,
  handleCloudAntigravityPreInvocation,
  handleCloudAntigravitySessionStart,
  handleCloudAntigravityStop,
  handleCloudSessionStart,
} from './cloud-hooks.js';
import { cloudAccess, HOOK_TIMEOUT_MS } from './cloud-inbox.js';
import { copilotServerAddress } from './copilot-adapter.js';
import { fileSpool } from './copilot-spool.js';
import { isDevinHookEvent, runDevinHook } from './devin-hooks.js';
import {
  cloudCopilotBackend,
  copilotWorkspace,
  localCopilotBackend,
  runCopilotHook,
  type CopilotHookBackend,
} from './copilot-hooks.js';
import { observeHookEvent } from './inbox-observe.js';
import { drainInbox, registerPullEndpoint } from './inbox.js';
import { antigravitySessionStartMessage, sessionStartMessage } from './session-start-message.js';
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

const antigravityPayloadSchema = z
  .object({ workspacePaths: z.array(z.string()).optional() })
  .loose();

/** The workspace an Antigravity hook is for: its payload's first workspace path, else cwd. */
export function antigravityWorkspace(rawJson: string): string {
  try {
    const raw: unknown = JSON.parse(rawJson);
    const parsed = antigravityPayloadSchema.safeParse(raw);
    return (parsed.success ? parsed.data.workspacePaths?.[0] : undefined) ?? process.cwd();
  } catch {
    return process.cwd();
  }
}

/**
 * Handle Antigravity SessionStart hook: extracts conversationId, registers
 * presence, and returns a persistent system message with the derived agent id.
 */
export function handleAntigravitySessionStart(
  repos: Repositories,
  rawJson: string,
  workspace: string = process.cwd(),
): { agentId: string | undefined; output: string } {
  const sessionId = hookSessionId(rawJson);
  if (sessionId === undefined) {
    return {
      agentId: undefined,
      output: JSON.stringify({
        injectSteps: [{ ephemeralMessage: `Concord: ${UNRESOLVED_IDENTITY_MESSAGE}` }],
      }),
    };
  }
  const identity = {
    agentId: agentIdForSession('antigravity', sessionId),
    kind: 'antigravity',
    origin: 'hook' as const,
  };
  const agentId = identity.agentId;
  ensureAgentRegistered(repos, identity, workspace);
  registerPullEndpoint(repos, agentId, 'antigravity');

  const others = buildRoster(repos.agents.list(), Date.now()).filter(
    (entry) => entry.agentId !== agentId,
  );
  const msg = antigravitySessionStartMessage(agentId, others);
  return {
    agentId,
    output: JSON.stringify({
      injectSteps: [{ systemMessage: msg }],
    }),
  };
}

/**
 * Read evidence the hook carries first (a transcript, where Antigravity gives
 * one), then deliver what is waiting to this conversation.
 */
function observeThenDrain(
  repos: Repositories,
  agentId: string,
  rawJson: string,
  sessionId: string,
): DeliverableMessage[] {
  observeHookEvent(repos, agentId, rawJson);
  return drainInbox(repos, agentId, 'antigravity', undefined, {
    session: sessionKey(sessionId),
    via: 'hook',
  });
}

/**
 * Handle Antigravity PreInvocation hook: extracts conversationId, registers
 * presence, drains pending inbox messages, and injects them as userMessages,
 * asking the agent to start its idle monitor when none is watching.
 */
export function handleAntigravityPreInvocation(
  repos: Repositories,
  rawJson: string,
  workspace: string = process.cwd(),
): { output: string } {
  const sessionId = hookSessionId(rawJson);
  if (sessionId === undefined) {
    return { output: JSON.stringify({ injectSteps: [] }) };
  }
  const identity = {
    agentId: agentIdForSession('antigravity', sessionId),
    kind: 'antigravity',
    origin: 'hook' as const,
  };
  const agentId = identity.agentId;
  ensureAgentRegistered(repos, identity, workspace);

  const messages = observeThenDrain(repos, agentId, rawJson, sessionId);
  const watching = receiverActive(repos.agentEndpoints.getByAgent(agentId));
  return {
    output: JSON.stringify({
      injectSteps: antigravityInjectSteps(
        messages,
        antigravityMonitorNudge(rawJson, agentId, watching),
      ),
    }),
  };
}

/**
 * Handle Antigravity Stop hook: checks if pending inbox messages exist;
 * if so, drains them and tells Antigravity to continue the turn.
 */
export function handleAntigravityStop(repos: Repositories, rawJson: string): { output: string } {
  const sessionId = hookSessionId(rawJson);
  if (sessionId === undefined) {
    return { output: JSON.stringify({}) };
  }
  const agentId = agentIdForSession('antigravity', sessionId);
  const messages = observeThenDrain(repos, agentId, rawJson, sessionId);
  if (messages.length === 0) {
    return { output: JSON.stringify({}) };
  }
  return {
    output: JSON.stringify({
      decision: 'continue',
      reason: `New Concord message(s) arrived before this turn ended.\n\n${renderInboxBody(messages)}`,
    }),
  };
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
      'Run a Concord hook. events: pre-tool-use (PreToolUse overlap gate), ' +
        'session-start (SessionStart presence auto-register), pre-invocation, post-tool-use, and stop.',
    )
    .option('--client <client>', 'Client calling the hook (e.g. antigravity, copilot-cli, claude)')
    .action(async (event, options) => {
      if (isDevinHookEvent(event)) {
        process.stdout.write(`${await runDevinHook(event, readStdin())}\n`);
        return;
      }
      if (options.client === 'copilot-cli') {
        await runCopilotClientHook(event);
        return;
      }
      // Copilot CLI also runs the hooks in a project's .claude/settings.json.
      // Its own session-start hook registers the session under the right kind;
      // this one would mint a claude-code id for a session that is not one.
      if (event === 'session-start' && (process.env['COPILOT_CLI'] ?? '') !== '') return;
      // For Antigravity hooks, read stdin once and derive the workspace from
      // the payload's workspacePaths.  Global hooks run with cwd set to
      // ~/.gemini/config, so the payload is the only reliable source.
      const isAntigravity = options.client === 'antigravity';
      const antigravityInput = isAntigravity ? readStdin() : '';
      const workspace = isAntigravity ? antigravityWorkspace(antigravityInput) : process.cwd();

      const access = cloudAccess(workspace, { timeoutMs: HOOK_TIMEOUT_MS });
      if (access.kind === 'unusable') {
        // Never a local workspace in its place, and never a blocked edit or session.
        process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
        if (isAntigravity) {
          if (event === 'session-start' || event === 'pre-invocation') {
            process.stdout.write(`${JSON.stringify({ injectSteps: [] })}\n`);
          } else if (event === 'stop') {
            process.stdout.write(`${JSON.stringify({})}\n`);
          }
        }
        return;
      }
      if (access.kind === 'cloud') {
        await runCloudHook(access.runtime, event, options.client, antigravityInput);
        return;
      }

      if (isAntigravity) {
        const repos = openContext(workspace).repos;
        if (event === 'session-start') {
          const result = handleAntigravitySessionStart(repos, antigravityInput, workspace);
          process.stdout.write(`${result.output}\n`);
          return;
        }
        if (event === 'pre-invocation') {
          const result = handleAntigravityPreInvocation(repos, antigravityInput, workspace);
          process.stdout.write(`${result.output}\n`);
          return;
        }
        if (event === 'stop') {
          const result = handleAntigravityStop(repos, antigravityInput);
          process.stdout.write(`${result.output}\n`);
          return;
        }
        process.stderr.write(`Unknown hook event for antigravity: ${event}\n`);
        process.exitCode = 1;
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

/** A Copilot CLI hook, against Concord Cloud when the repository is linked. */
async function runCopilotClientHook(event: string): Promise<void> {
  const input = readStdin();
  const workspace = copilotWorkspace(input);
  const access = cloudAccess(workspace, { timeoutMs: HOOK_TIMEOUT_MS });
  if (access.kind === 'unusable') {
    // Never a local workspace in its place, and never a blocked session.
    process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
    process.stdout.write('{}\n');
    return;
  }
  let backend: CopilotHookBackend;
  let repoRoot: string;
  if (access.kind === 'cloud') {
    backend = cloudCopilotBackend(access.runtime);
    repoRoot = access.runtime.repoRoot;
  } else {
    const context = openContext(workspace);
    backend = localCopilotBackend(context.repos, context.repoRoot);
    repoRoot = context.repoRoot;
  }
  const output = await runCopilotHook(
    {
      backend,
      spool: fileSpool(repoRoot),
      env: process.env,
      serverAddress: copilotServerAddress(),
    },
    event,
    input,
  );
  if (output === undefined) {
    process.stderr.write(`Unknown hook event for copilot-cli: ${event}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${output}\n`);
}

/**
 * A hook in a repository linked to Concord Cloud. Neither may break the
 * session: a cloud that cannot be reached is said once, and the edit or the
 * session goes ahead.
 */
async function runCloudHook(
  runtime: CloudRuntime,
  event: string,
  client?: string,
  antigravityInput = '',
): Promise<void> {
  if (client === 'antigravity') {
    const input = antigravityInput !== '' ? antigravityInput : readStdin();
    if (event === 'session-start') {
      const result = await handleCloudAntigravitySessionStart(runtime, input);
      process.stdout.write(`${result.output}\n`);
      return;
    }
    if (event === 'pre-invocation') {
      const result = await handleCloudAntigravityPreInvocation(runtime, input);
      process.stdout.write(`${result.output}\n`);
      return;
    }
    if (event === 'stop') {
      const result = await handleCloudAntigravityStop(runtime, input);
      process.stdout.write(`${result.output}\n`);
      return;
    }
    process.stderr.write(`Unknown hook event for antigravity: ${event}\n`);
    process.exitCode = 1;
    return;
  }

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
