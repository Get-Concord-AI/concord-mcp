import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { Command } from '@commander-js/extra-typings';

import { resolveRepoRoot, workspaceIdForRoot } from '../../config/paths.js';
import { CONCORD_GLOBAL_INSTRUCTIONS } from '../../install/instructions.js';
import type { ClaimOptions, Repositories } from '../../db/index.js';
import {
  capabilityFor,
  effectiveEndpointCapabilities,
  encodeCapabilities,
  monitorCapabilityFor,
  receiverActive,
  type EndpointCapability,
} from '../../domain/delivery.js';
import { grokMonitorNudge } from '../../domain/grok-monitor.js';
import { harnessConfigFor } from '../../domain/harness-config.js';
import { hookSessionId, resolveSessionId } from '../../domain/identity.js';
import { sessionKey } from '../../domain/receipts.js';
import {
  renderGeminiAfterAgent,
  renderGeminiAfterTool,
  renderHookPayload,
  renderMonitorLines,
  toDeliverable,
  type DeliverableMessage,
} from '../../domain/pull-inbox.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import type { TelemetryRecorder } from '../../telemetry/events.js';
import { resolveAgentId, resolveInboxOwner } from '../agent-identity.js';
import { monitorInstanceId, resolveLiveAgent } from '../live-identity.js';
import { resolveStore } from '../../workspaces/store.js';
import { launchDetachedConcord } from '../detached-host.js';
import { codexThreadHostable } from '../embedding-host.js';
import { eventName, isSubagentHook, observeHookEvent, parseObservedHook } from './inbox-observe.js';
import {
  claimWaiter,
  defaultWaiterDir,
  hostsRewake,
  renderRewake,
  REWAKE_EXIT_CODE,
  rewakeWaits,
  standDownWhenSuperseded,
  supersedeWaiter,
} from './inbox-rewake.js';
import { CONCORD_SERVER_ONLY } from './session-start-message.js';
import {
  cloudAccess,
  drainFromCloud,
  HOOK_TIMEOUT_MS,
  registerInCloud,
  watchCloud,
  watching,
} from './cloud-inbox.js';

/** How long a registered pull endpoint stays promptable between drains. */
const PULL_ENDPOINT_TTL_MS = 90_000;
/** A receiver that misses this many seconds of polls is no longer advertised. */
const MIN_RECEIVER_TTL_MS = 10_000;

function receiverExpiry(interval: number, now = Date.now()): string {
  return new Date(now + Math.max(MIN_RECEIVER_TTL_MS, interval * 3)).toISOString();
}

export function heartbeatReceiver(
  repos: Repositories,
  agentId: string,
  interval: number,
  owner: string,
): void {
  const endpoint = repos.agentEndpoints.getByAgent(agentId);
  if (endpoint === undefined) throw new Error(`Agent ${agentId} has no registered endpoint.`);
  repos.agentEndpoints.heartbeatReceiver(endpoint.endpointId, receiverExpiry(interval), owner);
}

/**
 * Advertise that `agentId` can receive messages by draining them from inside
 * its own session. Re-registering refreshes the lease, so a session that dies
 * stops looking promptable instead of silently swallowing messages.
 */
export function registerPullEndpoint(
  repos: Repositories,
  agentId: string,
  provider: string,
  now = Date.now(),
  capability: EndpointCapability = capabilityFor(provider),
): void {
  // The endpoint references an agent row. Hook execution order is not
  // guaranteed, so do not assume the presence hook has already run — otherwise
  // whether messaging works depends on which SessionStart hook fired first.
  ensureAgentRegistered(repos, { agentId, kind: provider }, process.cwd());
  const existing = repos.agentEndpoints.getByAgent(agentId);
  const preservePush = existing?.transport === 'local-ipc' && existing.status === 'connected';
  const preserveReceiver = effectiveEndpointCapabilities(existing, now).includes('idle');
  const capabilities =
    preservePush || preserveReceiver
      ? [...new Set([...(existing?.capabilities ?? []), ...encodeCapabilities(capability)])]
      : encodeCapabilities(capability);
  repos.agentEndpoints.upsert({
    endpointId: existing?.endpointId ?? randomUUID(),
    agentId,
    provider,
    transport: preservePush ? existing.transport : capability.transport,
    capabilities,
    address: preservePush ? existing.address : `${capability.transport}:${agentId}`,
    credentialHash: existing?.credentialHash ?? randomBytes(32).toString('hex'),
    status: 'connected',
    expiresAt: new Date(now + PULL_ENDPOINT_TTL_MS).toISOString(),
  });
}

/**
 * Take every sent message for `agentId` and mark it delivered to the session
 * in `options`. Draining is what records delivery, so a message is only ever
 * counted as delivered once the recipient's session has been handed it. It is
 * never counted as read here: that takes evidence from the session itself.
 */
export function drainInbox(
  repos: Repositories,
  agentId: string,
  provider: string,
  capability: EndpointCapability = capabilityFor(provider),
  options: ClaimOptions = {},
): DeliverableMessage[] {
  registerPullEndpoint(repos, agentId, provider, Date.now(), capability);
  const claimed = repos.agentMessages.claimPendingForRecipient(agentId, provider, options);
  repos.agents.heartbeat(agentId);
  return claimed.map(toDeliverable);
}

/** The opaque key of the session this command runs for, when it can tell. */
export function currentSession(provider: string, hookPayload: string | undefined): string | null {
  const raw = resolveSessionId(process.env, {
    kind: provider,
    ...(hookPayload === undefined ? {} : { hookPayload }),
  });
  return raw === undefined ? null : sessionKey(raw);
}

export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

export interface WatchOptions {
  /** Hook payload naming the session, when the watcher runs as a hook. */
  hookPayload?: string;
  /** Whether a newer watcher for this agent has replaced this one. */
  replaced?: () => boolean;
  /**
   * Re-resolve who this watcher serves on every poll. A monitor that survives
   * a `/resume` keeps its spawn-time session id while the session's live
   * binding moves; resolving per poll lets the watcher follow it (#180).
   */
  resolveTarget?: () => { agentId: string; session: string | null };
  /**
   * Whether polls mark the receiver heartbeat. A waiter that only covers a
   * missing monitor must not beat one: its own heartbeat would make the next
   * Stop see a live receiver and stand down into a delivery gap.
   */
  receiverHeartbeat?: boolean;
  /**
   * Checked before each poll round: while it holds, the watcher neither
   * drains nor heartbeats but keeps polling. A rewake fallback armed beside
   * a live monitor uses it to stay dormant until the monitor's lease
   * actually expires — a crash right before Stop leaves a fresh lease
   * behind, and without the recheck nothing would ever take over.
   */
  pauseWhile?: () => boolean;
}

/**
 * Poll until a monitor receives a message or the owning harness stops it.
 * Signal listeners are removed on every completion path: leaving them attached
 * keeps Node's event loop alive after `--once`, which prevents harnesses such
 * as Gemini from observing the background command completion.
 */
export async function watchInbox(
  repos: Repositories,
  agentId: string,
  provider: string,
  interval: number,
  once: boolean,
  emit: (messages: readonly DeliverableMessage[]) => void,
  options: WatchOptions = {},
): Promise<void> {
  const monitorCapability = monitorCapabilityFor(provider);
  const session = currentSession(provider, options.hookPayload);
  const replaced = options.replaced ?? (() => false);
  // The lease owner: only this watcher may clear what it heartbeats, so a
  // stale watcher's teardown cannot drop a replacement monitor's receiver.
  const receiverOwner = monitorInstanceId(process.env);
  // The agent and session stamped on each delivery follow resolveTarget when
  // present; finish() unwinds the endpoint of whoever was served last.
  let servedAgentId = agentId;
  let servedSession = session;
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      process.off('SIGINT', stopWatching);
      process.off('SIGTERM', stopWatching);
      try {
        registerPullEndpoint(repos, servedAgentId, provider);
        const endpoint = repos.agentEndpoints.getByAgent(servedAgentId);
        // A replaced watcher leaves the receiver to the one that replaced it;
        // an owner-token check keeps a stale teardown from clearing a lease
        // this process never held.
        if (endpoint !== undefined && !replaced()) {
          repos.agentEndpoints.clearReceiver(endpoint.endpointId, receiverOwner);
        }
      } catch (registrationError) {
        if (error === undefined) error = registrationError;
      }
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error('Inbox monitor failed.'));
    };
    const poll = (): void => {
      if (options.pauseWhile?.() === true) {
        timer = setTimeout(poll, interval);
        return;
      }
      let messages: DeliverableMessage[];
      try {
        const target = options.resolveTarget?.() ?? {
          agentId: servedAgentId,
          session: servedSession,
        };
        servedAgentId = target.agentId;
        servedSession = target.session;
        messages = drainInbox(repos, target.agentId, provider, monitorCapability, {
          session: target.session,
          via: 'monitor',
        });
        if (options.receiverHeartbeat !== false) {
          heartbeatReceiver(repos, target.agentId, interval, receiverOwner);
        }
      } catch (error) {
        // A monitor is the session's live receive endpoint. Transient SQLite
        // contention must delay a poll, never tear that endpoint down.
        if (isSqliteBusy(error)) {
          timer = setTimeout(poll, interval);
          return;
        }
        finish(error);
        return;
      }
      if (messages.length > 0) emit(messages);
      if (once && messages.length > 0) {
        finish();
        return;
      }
      timer = setTimeout(poll, interval);
    };
    function stopWatching(): void {
      finish();
    }
    process.once('SIGINT', stopWatching);
    process.once('SIGTERM', stopWatching);
    poll();
  });
}

/**
 * Whether this repository already uses Concord.
 *
 * The relay plugin is installed once and then loads in every session, including
 * repositories that have nothing to do with Concord. Opening a workspace
 * creates it, so these commands must check first and stay quiet otherwise —
 * merely having the plugin installed should never litter unrelated projects
 * with `.concord/` state.
 */
/**
 * Read a hook payload piped on stdin. Only ever called behind `--from-hook`:
 * a plugin monitor's stdin may stay open for the life of the session, and
 * blocking on it there would silently wedge message delivery.
 */
export function readHookPayload(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return undefined;
  }
}

export function registeredLine(agentId: string, provider: string): string {
  // A harness monitor may not inherit the session's environment (Grok's does
  // not), so hand the agent the exact command with its id already filled in.
  const monitor = harnessConfigFor(provider)?.monitor.command?.replace('<agent-id>', agentId);
  return (
    `Concord: this session is agent \`${agentId}\` and can receive live messages from other ` +
    `agents. If a Concord tool asks for agent_id, use "${agentId}"; do not invent a ` +
    `different id. ${CONCORD_SERVER_ONLY}` +
    (monitor === undefined ? '' : ` Start its inbox monitor with: \`${monitor}\`.`) +
    '\n'
  );
}

/**
 * What a hook needs to point its session at this workspace: the id to pass to
 * Concord's tools, and, for a repository in the machine-wide store, the
 * instructions it has no file of its own for.
 */
export function workspaceStatus(cwd: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const repoRoot = resolveRepoRoot(cwd, env);
  const store = resolveStore(repoRoot, env);
  return {
    workspace_id: workspaceIdForRoot(repoRoot),
    store: store.kind,
    ...(store.kind === 'global'
      ? { project: store.project, instructions: CONCORD_GLOBAL_INSTRUCTIONS }
      : {}),
  };
}

/**
 * Whether hooks here have a workspace to serve. A repository's own store must
 * already exist; the machine-wide store counts as soon as global mode chooses
 * it, since a session's first hook can run before its MCP server creates it.
 */
export function workspaceExists(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const store = resolveStore(resolveRepoRoot(cwd, env), env);
    return store.kind === 'global' || existsSync(store.databasePath);
  } catch {
    return false;
  }
}

function launchCodexAdapterHost(repoRoot: string, agentId: string, threadId: string): void {
  launchDetachedConcord(repoRoot, [
    'adapters',
    'host-codex',
    '--agent',
    agentId,
    '--thread',
    threadId,
  ]);
}

function recordDeliveredMessages(
  telemetry: TelemetryRecorder | undefined,
  messages: readonly DeliverableMessage[],
): void {
  for (const message of messages) {
    telemetry?.recordEvent({
      event_type: 'message_delivery',
      task_flow_id: message.taskId === null ? null : telemetry.taskPseudonym(message.taskId),
      message_kind: message.messageKind,
      stage: 'receive',
      result: 'delivered',
      delivery_mode: 'pull',
      error_code: null,
      latency_ms: message.deliveryLatencyMs,
    });
  }
}

/** Drain formats a hook prints, as opposed to a monitor or a script. */
const HOOK_FORMATS: readonly string[] = [
  'post-tool-use',
  'stop',
  'gemini-after-tool',
  'gemini-after-agent',
];

const DRAIN_FORMATS: readonly string[] = [
  'json',
  'monitor',
  'gemini-after-tool',
  'gemini-after-agent',
  'post-tool-use',
  'stop',
];

/** Writes drained messages in a hook's or a monitor's format. */
function writeMessages(format: string, messages: readonly DeliverableMessage[]): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(messages)}\n`);
    return;
  }
  if (format === 'monitor') {
    for (const line of renderMonitorLines(messages)) process.stdout.write(`${line}\n`);
    return;
  }
  if (format === 'gemini-after-tool') {
    process.stdout.write(renderGeminiAfterTool(messages));
    return;
  }
  if (format === 'gemini-after-agent') {
    process.stdout.write(renderGeminiAfterAgent(messages));
    return;
  }
  if (format === 'post-tool-use' || format === 'stop') {
    process.stdout.write(renderHookPayload(format, messages));
    return;
  }
  throw new Error(`Unknown --format: ${format}`);
}

/** Keeps a Grok turn open once so the agent starts the monitor its plugin cannot. */
function writeMonitorNudge(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

/** A cloud failure in a hook: said once on stderr, never failing the session's turn. */
function reportCloudFailure(detail: string): void {
  process.stderr.write(`Concord Cloud could not be reached: ${detail}\n`);
}

/**
 * What `inbox observe` does with the hook payload already read — apart from
 * stdin so tests can drive it. The plugin runs this on SessionStart,
 * UserPromptSubmit, PreToolUse, Notification and SessionEnd in every
 * repository once installed, so nothing here may ever fail the hook: an
 * identity that does not resolve or a store that cannot open is logged at
 * most, never thrown.
 */
export async function observeInboxHook(
  payload: string,
  options: { readonly agent?: string | undefined; readonly provider: string },
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<void> {
  // The waiter claim is plain local state, so SessionEnd cleanup runs for
  // cloud sessions too — before the access check below would return. An
  // ended cloud session's waiter would otherwise keep renewing its lease
  // and drain batches into stderr nothing reads. Only the session's own end
  // counts: a subagent's says nothing about the session's waiter.
  const earlyHook = parseObservedHook(payload);
  if (
    earlyHook !== undefined &&
    eventName(earlyHook) === 'SessionEnd' &&
    !isSubagentHook(earlyHook)
  ) {
    try {
      const agentId = resolveAgentId(options.agent, env, {
        kind: options.provider,
        hookPayload: payload,
      });
      supersedeWaiter(agentId, defaultWaiterDir(env));
    } catch {
      // Never fail the hook: a waiter left armed expires with its lease.
    }
  }
  const access = cloudAccess(cwd, { timeoutMs: HOOK_TIMEOUT_MS }, env);
  if (access.kind !== 'local' || !workspaceExists(cwd, env)) return;
  try {
    const agentId = resolveAgentId(options.agent, env, {
      kind: options.provider,
      hookPayload: payload,
    });
    const context = await import('../context.js');
    observeHookEvent(context.openContext(cwd, env).repos, agentId, payload, options.provider);
  } catch (error) {
    // Never fail the hook: a missed observation only leaves a message unseen.
    process.stderr.write(
      `Concord: could not record hook event: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export function registerInboxCommand(program: Command, telemetry?: TelemetryRecorder): void {
  const inbox = program
    .command('inbox')
    .description('Receive live messages other agents addressed to this session');

  inbox
    .command('status')
    .description('Exit 0 when this directory is a Concord workspace, 1 otherwise')
    .option('--cloud', 'Exit 0 only when the repository is linked to Concord Cloud')
    .option('--json', 'Print the workspace id and the store it uses, for hooks')
    .action((options) => {
      // Lets the relay monitor bail out of a project that does not use Concord
      // instead of polling for the life of the session.
      const access = cloudAccess(process.cwd());
      if (access.kind === 'unusable') {
        // Nothing here can receive messages until the machine logs in again.
        process.stderr.write(`Concord Cloud: ${access.reason}\n`);
        process.exitCode = 1;
        return;
      }
      if (access.kind === 'cloud') {
        process.stdout.write(
          options.json === true ? '{"store":"cloud"}\n' : 'Concord Cloud workspace linked.\n',
        );
        return;
      }
      if (options.cloud === true || !workspaceExists(process.cwd())) {
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        options.json === true
          ? `${JSON.stringify(workspaceStatus(process.cwd(), process.env))}\n`
          : 'Concord workspace present.\n',
      );
    });

  inbox
    .command('register')
    .description('Advertise this session as able to receive messages by draining them')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the current session')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .option('--from-hook', 'Read the session id from a hook payload on stdin (Codex)')
    .action(async (options) => {
      const access = cloudAccess(process.cwd(), { timeoutMs: HOOK_TIMEOUT_MS });
      if (access.kind === 'local' && !workspaceExists(process.cwd())) return;
      if (access.kind === 'unusable') {
        reportCloudFailure(access.reason);
        return;
      }
      const hookPayload = options.fromHook === true ? (readHookPayload() ?? '') : undefined;
      const agentId = resolveAgentId(options.agent, process.env, {
        kind: options.provider,
        ...(hookPayload === undefined ? {} : { hookPayload }),
      });
      if (access.kind === 'cloud') {
        try {
          await registerInCloud(access.runtime, agentId, options.provider, process.cwd());
        } catch (error) {
          reportCloudFailure(error instanceof Error ? error.message : String(error));
          return;
        }
        // Codex is delivered to live by a host on this machine; start one
        // unless one already holds this session's receiver.
        const threadId = hookPayload === undefined ? undefined : hookSessionId(hookPayload);
        if (
          options.provider === 'codex' &&
          threadId !== undefined &&
          codexThreadHostable(process.env) &&
          !watching(access.runtime, agentId)
        ) {
          launchCodexAdapterHost(access.runtime.repoRoot, agentId, threadId);
        }
        process.stdout.write(registeredLine(agentId, options.provider));
        return;
      }
      const context = await import('../context.js').then((module) =>
        module.openContext(process.cwd()),
      );
      const existing =
        options.provider === 'codex' ? context.repos.agentEndpoints.getByAgent(agentId) : undefined;
      registerPullEndpoint(context.repos, agentId, options.provider);
      // A SessionStart payload says whether this is a fresh session, which
      // takes back what an earlier session was handed but never read.
      if (hookPayload !== undefined) {
        observeHookEvent(context.repos, agentId, hookPayload, options.provider);
      }
      const alreadyHosted =
        existing?.transport === 'local-ipc' &&
        existing.status === 'connected' &&
        (existing.expiresAt === null || Date.parse(existing.expiresAt) > Date.now());
      const threadId = hookPayload === undefined ? undefined : hookSessionId(hookPayload);
      if (
        options.provider === 'codex' &&
        threadId !== undefined &&
        codexThreadHostable(process.env) &&
        !alreadyHosted
      ) {
        launchCodexAdapterHost(context.repoRoot, agentId, threadId);
      }
      // Name the id. Clients whose session Concord can read resolve it on every
      // tool call; clients that scrub their environment (Codex) cannot, and for
      // those this line is the only place the agent learns who it is.
      process.stdout.write(registeredLine(agentId, options.provider));
    });

  inbox
    .command('drain')
    .description('Print and acknowledge every message waiting for this agent')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the current session')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .option('--from-hook', 'Read the session id from a hook payload on stdin (Codex)')
    .option(
      '--payload-stdin',
      'Read a hook payload on stdin for read receipts only; identity still comes from --agent',
    )
    .option(
      '--format <format>',
      'post-tool-use and stop emit hook JSON; monitor emits one line per message; json emits raw records',
      'json',
    )
    .action(async (options) => {
      const access = cloudAccess(process.cwd(), { timeoutMs: HOOK_TIMEOUT_MS });
      if (access.kind === 'local' && !workspaceExists(process.cwd())) return;
      // Checked before anything is taken: a format typo must not cost a batch.
      if (!DRAIN_FORMATS.includes(options.format)) {
        throw new Error(`Unknown --format: ${options.format}`);
      }
      if (access.kind === 'unusable') {
        reportCloudFailure(access.reason);
        return;
      }
      const grokStop = options.provider === 'grok' && options.format === 'stop';
      // Hook formats only ever run as hooks, whose stdin always ends, so the
      // payload (read evidence, subagent marker) is safe to read even without
      // --from-hook. Identity still comes from it only with --from-hook.
      const hookPayload =
        options.fromHook === true ||
        options.payloadStdin === true ||
        HOOK_FORMATS.includes(options.format)
          ? (readHookPayload() ?? '')
          : undefined;
      const identityOptions = {
        kind: options.provider,
        ...(options.fromHook === true ? { hookPayload } : {}),
      };
      // The receiver lookup runs only on a Grok Stop, never on the per-tool-call hook path.
      const monitorNudge = (agent: string, receiverIsActive: () => boolean): string | undefined =>
        grokStop && hookPayload !== undefined
          ? grokMonitorNudge(hookPayload, agent, receiverIsActive())
          : undefined;
      if (access.kind === 'cloud') {
        // Cloud identity stays environment-based: session bindings are local.
        const agentId = resolveInboxOwner(options.agent, process.env, identityOptions);
        let messages: DeliverableMessage[];
        try {
          messages = await drainFromCloud(access.runtime, agentId, options.provider);
        } catch (error) {
          reportCloudFailure(error instanceof Error ? error.message : String(error));
          return;
        }
        if (messages.length > 0) {
          writeMessages(options.format, messages);
        } else {
          const nudge = monitorNudge(agentId, () => watching(access.runtime, agentId));
          if (nudge !== undefined) writeMonitorNudge(nudge);
        }
        return;
      }
      // A subagent shares its parent's session id, so its hooks resolve the
      // parent's agent. Draining there would hand the parent's messages to
      // whichever subagent ran a tool, and its activity proves nothing about
      // what the parent's model saw (#216).
      if (hookPayload !== undefined && isSubagentHook(parseObservedHook(hookPayload))) return;
      const context = await import('../context.js').then((module) =>
        module.openContext(process.cwd()),
      );
      const isMonitor = options.format === 'monitor';
      let agentId: string;
      let drifted = false;
      if (hookPayload !== undefined) {
        // A hook invocation already knows its live session — from the payload
        // with --from-hook, or from the fresh environment otherwise.
        agentId = resolveInboxOwner(options.agent, process.env, identityOptions);
        // Read evidence first, so this invocation never marks read a message it
        // is itself about to deliver.
        observeHookEvent(context.repos, agentId, hookPayload, options.provider);
      } else {
        // Payload-less drains — the plugin monitor's per-poll spawn and manual
        // drains — carry the session id frozen at spawn. The binding the
        // session's hooks recorded for this client corrects it after a
        // /resume (#180). On drift the monitor cannot know the new session id
        // (it is keyed by it), so receipts are recorded under no session
        // rather than the abandoned one.
        const live = resolveLiveAgent(
          context.repos,
          options.agent,
          process.env,
          context.repoRoot,
          identityOptions,
        );
        agentId = live.agentId;
        drifted = live.drifted;
      }
      const messages = drainInbox(
        context.repos,
        agentId,
        options.provider,
        isMonitor ? monitorCapabilityFor(options.provider) : capabilityFor(options.provider),
        {
          session: drifted ? null : currentSession(options.provider, hookPayload),
          via: isMonitor ? 'monitor' : 'hook',
        },
      );
      if (isMonitor)
        heartbeatReceiver(context.repos, agentId, 2_000, monitorInstanceId(process.env));
      // Silence matters: a hook that prints on an empty inbox would inject
      // noise into the session on every single tool call.
      if (messages.length === 0) {
        const nudge = monitorNudge(agentId, () =>
          receiverActive(context.repos.agentEndpoints.getByAgent(agentId)),
        );
        if (nudge !== undefined) writeMonitorNudge(nudge);
        return;
      }
      recordDeliveredMessages(telemetry, messages);
      writeMessages(options.format, messages);
    });

  inbox
    .command('observe')
    .description('Record what a session hook saw: messages shown to the agent, or a fresh start')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the hook payload')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .action(async (options) => {
      // Seen-tracking lives in the local store; Concord Cloud keeps its own
      // delivery record. Prints nothing: UserPromptSubmit output becomes context.
      await observeInboxHook(readHookPayload() ?? '', options);
    });

  inbox
    .command('rewake')
    .description(
      'Wait in an asyncRewake hook for the next message, then wake an idle Claude session',
    )
    .action(async () => {
      const entrypoint = process.env['CLAUDE_CODE_ENTRYPOINT']?.trim();
      // `-p` runs are one-shot and Claude Code kills their async hooks at
      // teardown; there is no idle session to wake, and stdin may never close.
      if (entrypoint === 'sdk-cli') return;
      const sdkHost = hostsRewake(process.env);
      const access = cloudAccess(process.cwd());
      if (access.kind === 'local' && !workspaceExists(process.cwd())) return;
      if (access.kind === 'unusable') return;
      const hookPayload = readHookPayload() ?? '';
      const parsedHook = parseObservedHook(hookPayload);
      if (parsedHook !== undefined && isSubagentHook(parsedHook)) return;
      // A waiter only makes sense inside a real hook invocation: a manual run
      // has no session to wake.
      if (!sdkHost && hookPayload.trim() === '') return;
      const agentId = resolveInboxOwner(undefined, process.env, {
        kind: 'claude-code',
        hookPayload,
      });
      // The context opens lazily: SDK hosts skip the receiver check — they
      // have no monitor — and only pay for it when the watch itself starts.
      let context: import('../context.js').CliContext | undefined;
      const localContext = async (): Promise<import('../context.js').CliContext> => {
        if (context !== undefined) return context;
        const opened = await import('../context.js').then((module) =>
          module.openContext(process.cwd()),
        );
        context = opened;
        return opened;
      };
      // Interactive sessions are reached by their plugin monitor, which beats
      // the receiver heartbeat every poll; the check below arms the waiter
      // only when that beat is missing — the gap #180 tracks.
      // Arm at every Stop, even while a receiver lease is fresh: a monitor
      // crashing just before this Stop leaves an unexpired lease behind, and
      // if the waiter never armed, nothing would recheck once it expired.
      // The waiter stays dormant instead — pauseWhile skips its drain rounds
      // for as long as a receiver is actually beating — so a healthy monitor
      // is never raced, and the fallback takes over the moment the lease
      // lapses. SDK hosts have no monitor ever; nothing pauses there.
      const dormant = (): boolean => {
        if (sdkHost) return false;
        try {
          return access.kind === 'cloud'
            ? watching(access.runtime, agentId)
            : receiverActive(context?.repos.agentEndpoints.getByAgent(agentId));
        } catch {
          return false;
        }
      };
      // Claim first, then decide: a fresh claim supersedes any older fallback
      // waiter still polling, so a Stop that must not wait still takes its
      // place down with it.
      const claim = claimWaiter(agentId, randomUUID());
      if (!rewakeWaits(process.env, undefined)) {
        claim.release();
        return;
      }
      const cancel = standDownWhenSuperseded(claim, () => {
        process.emit('SIGTERM', 'SIGTERM');
      });
      const wake = (messages: readonly DeliverableMessage[]): void => {
        if (messages.length === 0) return;
        // asyncRewake shows the model stderr, falling back to stdout.
        process.stderr.write(renderRewake(messages));
        process.exitCode = REWAKE_EXIT_CODE;
      };
      try {
        if (access.kind === 'cloud') {
          // The fallback drains like a monitor but is not one: advertising
          // watchingUntil would make the next Stop stand down into a gap once
          // this waiter is superseded, matching receiverHeartbeat: sdkHost.
          await watchCloud(access.runtime, agentId, 'claude-code', true, wake, {
            replaced: claim.superseded,
            monitor: false,
            pauseWhile: dormant,
          });
          return;
        }
        await watchInbox(
          (await localContext()).repos,
          agentId,
          'claude-code',
          1000,
          true,
          (messages) => {
            recordDeliveredMessages(telemetry, messages);
            wake(messages);
          },
          {
            hookPayload,
            replaced: claim.superseded,
            // An SDK waiter is the session's only receiver and keeps beating;
            // an interactive fallback must not, or the next Stop would see a
            // live receiver and stand down into a delivery gap.
            receiverHeartbeat: sdkHost,
            pauseWhile: dormant,
          },
        );
      } finally {
        cancel();
        claim.release();
      }
    });

  inbox
    .command('watch')
    .description('Wait for messages and emit one line per message for a harness monitor')
    .option('--agent <id>', 'Agent id; defaults to the current harness session')
    .option('--provider <name>', 'Client the agent runs in', 'grok')
    .option('--interval <ms>', 'Polling interval in milliseconds', '1000')
    .option('--once', 'Exit after emitting the first non-empty batch')
    .option('--from-hook', 'Read the native session id from a hook payload on stdin')
    .option('--format <format>', 'Output format: monitor or stop', 'monitor')
    .action(async (options) => {
      const access = cloudAccess(process.cwd());
      if (access.kind === 'local' && !workspaceExists(process.cwd())) return;
      if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
      const hookPayload = options.fromHook === true ? (readHookPayload() ?? '') : undefined;
      const identityOptions = {
        kind: options.provider,
        ...(hookPayload === undefined ? {} : { hookPayload }),
      };
      if (options.format !== 'monitor' && options.format !== 'stop') {
        throw new Error(`Unknown --format: ${options.format}`);
      }
      const format = options.format;
      if (access.kind === 'cloud') {
        // Cloud keeps environment identity: session bindings are local.
        const agentId = resolveInboxOwner(options.agent, process.env, identityOptions);
        // Long-polls the cloud, so --interval does not apply.
        await watchCloud(
          access.runtime,
          agentId,
          options.provider,
          options.once === true,
          (messages) => {
            writeMessages(format, messages);
          },
        );
        return;
      }
      const context = await import('../context.js').then((module) =>
        module.openContext(process.cwd()),
      );
      const parsedInterval = Number.parseInt(options.interval, 10);
      if (!Number.isFinite(parsedInterval) || parsedInterval < 250) {
        throw new Error('--interval must be at least 250 milliseconds.');
      }
      // A watcher that outlives a `/resume` keeps its spawn-time session id;
      // resolving the live binding on every poll lets it follow the session
      // the hooks now report (#180). With a hook payload the session is
      // already named, so identity stays static.
      const resolveTarget = (): { agentId: string; session: string | null } => {
        if (hookPayload !== undefined) {
          return {
            agentId: resolveInboxOwner(options.agent, process.env, identityOptions),
            session: currentSession(options.provider, hookPayload),
          };
        }
        const live = resolveLiveAgent(
          context.repos,
          options.agent,
          process.env,
          context.repoRoot,
          identityOptions,
        );
        return {
          agentId: live.agentId,
          session: live.drifted ? null : currentSession(options.provider, hookPayload),
        };
      };
      const first = resolveTarget();
      await watchInbox(
        context.repos,
        first.agentId,
        options.provider,
        parsedInterval,
        options.once === true,
        (messages) => {
          recordDeliveredMessages(telemetry, messages);
          writeMessages(format, messages);
        },
        {
          ...(hookPayload === undefined ? {} : { hookPayload }),
          resolveTarget,
        },
      );
    });

  inbox
    .command('release')
    .description("Drop this session's idle receiver lease, so hooks stop seeing a live monitor")
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the current session')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .action(async (options) => {
      const access = cloudAccess(process.cwd(), { timeoutMs: HOOK_TIMEOUT_MS });
      if (access.kind === 'local' && !workspaceExists(process.cwd())) return;
      if (access.kind === 'unusable') return;
      // Cloud receivers release themselves when their watch exits.
      if (access.kind === 'cloud') return;
      const context = await import('../context.js').then((module) =>
        module.openContext(process.cwd()),
      );
      // The lease lives on the agent the monitor serves now — after a /resume
      // drift that is the live binding's agent, not the spawn-time env's.
      const live = resolveLiveAgent(context.repos, options.agent, process.env, context.repoRoot, {
        kind: options.provider,
      });
      const endpoint = context.repos.agentEndpoints.getByAgent(live.agentId);
      if (endpoint !== undefined) {
        // Only the monitor instance that holds the lease may drop it: after a
        // /resume swap this process can resolve to an agent a replacement
        // monitor now serves, and clearing blindly would strand its receiver.
        context.repos.agentEndpoints.clearReceiver(
          endpoint.endpointId,
          monitorInstanceId(process.env),
        );
      }
    });
}
