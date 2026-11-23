import type { CloudRuntime } from '../../cloud/runtime.js';
import type { Repositories } from '../../db/index.js';
import { resolveIdentity, type AgentIdentity } from '../../domain/identity.js';
import { buildRoster } from '../../domain/presence.js';
import { renderInboxBody, type DeliverableMessage } from '../../domain/pull-inbox.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { cloudRoster } from './cloud-hooks.js';
import { cloudAccess, drainFromCloud, HOOK_TIMEOUT_MS, registerInCloud } from './cloud-inbox.js';
import { drainInbox, registerPullEndpoint } from './inbox.js';
import {
  sessionStartMessage,
  type ExplicitSessionIdentity,
  type RosterLine,
} from './session-start-message.js';

/**
 * The lifecycle-hook flow every hook-stdin harness shares: resolve identity
 * from the payload, register presence, drain the pull inbox on prompt submit,
 * and disconnect the endpoint at session end. What differs per harness is its
 * kind, its event names, the identity wording its SessionStart context needs,
 * and where its repository root comes from.
 */
export interface HarnessHookSpec {
  /** Client kind used for identity resolution and endpoint registration. */
  readonly kind: string;
  /** Identity wording for the SessionStart context. */
  readonly sessionIdentity: ExplicitSessionIdentity;
  /** Repository root for one hook invocation. */
  readonly repoRoot: (env: NodeJS.ProcessEnv, rawJson: string) => string;
}

export interface HarnessHooks {
  /** Whether `event` is one of this harness's three lifecycle events. */
  isEvent(event: string): boolean;
  sessionStartOutput(agentId: string, others: readonly RosterLine[]): string;
  promptSubmitOutput(messages: readonly DeliverableMessage[]): string;
  endSession(repos: Repositories, agentId: string): void;
  handleLocalHook(
    repos: Repositories,
    identity: AgentIdentity,
    repoRoot: string,
    event: string,
  ): string;
  handleCloudHook(
    runtime: CloudRuntime,
    identity: AgentIdentity,
    cwd: string,
    event: string,
  ): Promise<string>;
  run(event: string, rawJson: string, env?: NodeJS.ProcessEnv): Promise<string>;
}

const NO_OUTPUT = JSON.stringify({});

export function createHarnessHooks(spec: HarnessHookSpec): HarnessHooks {
  const events = {
    sessionStart: `${spec.kind}-session-start`,
    promptSubmit: `${spec.kind}-user-prompt-submit`,
    sessionEnd: `${spec.kind}-session-end`,
  } as const;
  const eventNames: readonly string[] = Object.values(events);

  function sessionStartOutput(agentId: string, others: readonly RosterLine[]): string {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: sessionStartMessage(agentId, others, spec.sessionIdentity),
      },
    });
  }

  /** These harnesses reject an empty additionalContext forwarded to the model. */
  function promptSubmitOutput(messages: readonly DeliverableMessage[]): string {
    if (messages.length === 0) return NO_OUTPUT;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: renderInboxBody(messages),
      },
    });
  }

  function endSession(repos: Repositories, agentId: string): void {
    const endpoint = repos.agentEndpoints.getByAgent(agentId);
    if (endpoint !== undefined) repos.agentEndpoints.disconnect(endpoint.endpointId);
  }

  function handleLocalHook(
    repos: Repositories,
    identity: AgentIdentity,
    repoRoot: string,
    event: string,
  ): string {
    switch (event) {
      case events.sessionStart:
        ensureAgentRegistered(repos, identity, repoRoot);
        registerPullEndpoint(repos, identity.agentId, spec.kind);
        return sessionStartOutput(
          identity.agentId,
          buildRoster(repos.agents.list(), Date.now()).filter(
            (peer) => peer.agentId !== identity.agentId,
          ),
        );
      case events.promptSubmit:
        return promptSubmitOutput(drainInbox(repos, identity.agentId, spec.kind));
      case events.sessionEnd:
        endSession(repos, identity.agentId);
        return NO_OUTPUT;
      default:
        return NO_OUTPUT;
    }
  }

  /**
   * The cloud has no endpoint disconnect: presence there lapses with
   * `last_seen`, and messages wait for the next session either way, so
   * session end is a no-op.
   */
  async function handleCloudHook(
    runtime: CloudRuntime,
    identity: AgentIdentity,
    cwd: string,
    event: string,
  ): Promise<string> {
    switch (event) {
      case events.sessionStart:
        await registerInCloud(runtime, identity.agentId, spec.kind, cwd);
        return sessionStartOutput(identity.agentId, await cloudRoster(runtime, identity.agentId));
      case events.promptSubmit:
        return promptSubmitOutput(await drainFromCloud(runtime, identity.agentId, spec.kind));
      case events.sessionEnd:
        return NO_OUTPUT;
      default:
        return NO_OUTPUT;
    }
  }

  /**
   * Never blocks the session: an unidentifiable payload or an unreachable
   * cloud yields no context (and a note on stderr), not a failed hook.
   */
  async function run(
    event: string,
    rawJson: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<string> {
    const identity = resolveIdentity(env, { kind: spec.kind, hookPayload: rawJson });
    if (identity === undefined) return NO_OUTPUT;
    const repoRoot = spec.repoRoot(env, rawJson);
    const access = cloudAccess(repoRoot, { timeoutMs: HOOK_TIMEOUT_MS }, env);
    if (access.kind === 'unusable') {
      process.stderr.write(`Concord Cloud could not be reached: ${access.reason}\n`);
      return NO_OUTPUT;
    }
    if (access.kind === 'local') {
      const { openContext } = await import('../context.js');
      return handleLocalHook(openContext(repoRoot, env).repos, identity, repoRoot, event);
    }
    try {
      return await handleCloudHook(access.runtime, identity, repoRoot, event);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Concord Cloud could not be reached: ${detail}\n`);
      return NO_OUTPUT;
    }
  }

  return {
    isEvent: (event) => eventNames.includes(event),
    sessionStartOutput,
    promptSubmitOutput,
    endSession,
    handleLocalHook,
    handleCloudHook,
    run,
  };
}
