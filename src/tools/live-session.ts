import type { Repositories } from '../db/index.js';
import { ancestorPids } from '../parent-chain.js';
import {
  identityForRequest,
  liveSessionIdentity,
  type AgentIdentity,
  type LiveSessionBinding,
  type OpenCodeRequestIdentityMetadata,
} from '../domain/identity.js';
import { deriveLiveness } from '../domain/presence.js';

/** The response shape a drift advisory can be appended to. */
export interface AdvisoryResponse {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/**
 * The session a call acts as: the binding a session-start hook recorded for
 * this server's client when one exists — it reflects a `/resume` the
 * spawn-time environment never saw. A stale binding lapses with its agent;
 * with no env identity to correct, the caller keeps its unproven path.
 */
export function liveSession(
  session: AgentIdentity | undefined,
  requestIdentity:
    ((meta: OpenCodeRequestIdentityMetadata | undefined) => AgentIdentity | undefined) | undefined,
): {
  sessionForRequest: (
    callRepos: Repositories,
    meta: OpenCodeRequestIdentityMetadata | undefined,
  ) => AgentIdentity | undefined;
  withDriftAdvisory: <T extends AdvisoryResponse>(result: T) => T;
} {
  /** Set on the first env-vs-hook identity drift, surfaced once per session. */
  let driftAdvisory: { text: string; from: string; to: string } | undefined;
  let driftAdvisoryShown = false;
  // The client pid this server answers to: its own parent, unless a shim sat
  // between them — then it is whichever ancestor a hook bound. The walk runs
  // at most once: session-start hooks precede tool use, so a miss now would
  // keep missing while paying the process-table read on every request.
  let boundPid = process.ppid;
  let searchedAncestors = false;
  const bindingFor = (callRepos: Repositories): LiveSessionBinding | undefined => {
    const direct = callRepos.sessionBindings.forClientPid(boundPid);
    if (direct !== undefined || searchedAncestors) return direct;
    searchedAncestors = true;
    for (const pid of ancestorPids(6)) {
      const found = callRepos.sessionBindings.forClientPid(pid);
      if (found !== undefined) {
        boundPid = pid;
        return found;
      }
    }
    return undefined;
  };

  const sessionForRequest = (
    callRepos: Repositories,
    meta: OpenCodeRequestIdentityMetadata | undefined,
  ): AgentIdentity | undefined => {
    const base = identityForRequest(session, requestIdentity?.(meta));
    const binding = bindingFor(callRepos);
    if (binding === undefined) return base;
    const bound = callRepos.agents.get(binding.agentId);
    if (bound === undefined || deriveLiveness(bound.lastSeen, Date.now()) === 'archived') {
      return base;
    }
    const live = liveSessionIdentity(base, binding);
    if (
      live.drifted &&
      live.identity !== undefined &&
      driftAdvisory === undefined &&
      !driftAdvisoryShown
    ) {
      driftAdvisory = {
        from: base?.agentId ?? '(none)',
        to: live.identity.agentId,
        text:
          `Concord: this server was launched as ${base?.agentId ?? 'an unnamed agent'} but ` +
          `the session hook for this client now reports ${live.identity.agentId} — the ` +
          'environment kept a session id a /resume or /clear replaced. Acting as the live one.',
      };
    }
    return live.identity;
  };

  const withDriftAdvisory = <T extends AdvisoryResponse>(result: T): T => {
    if (driftAdvisory === undefined) return result;
    const advisory = driftAdvisory;
    driftAdvisory = undefined;
    driftAdvisoryShown = true;
    return {
      ...result,
      content: [...result.content, { type: 'text', text: advisory.text }],
      structuredContent: {
        ...result.structuredContent,
        identity_drift: { env_agent_id: advisory.from, live_agent_id: advisory.to },
      },
    };
  };

  return { sessionForRequest, withDriftAdvisory };
}
