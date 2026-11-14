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

/** The one-time advisory produced when env and hook identities diverge. */
export interface DriftAdvisory {
  text: string;
  envAgentId: string;
  liveAgentId: string;
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
  /** The pending drift advisory, if one is owed — consumed once. */
  takeDriftAdvisory: () => DriftAdvisory | undefined;
} {
  /** Set on the first env-vs-hook identity drift, surfaced once per session. */
  let driftAdvisory: DriftAdvisory | undefined;
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
        envAgentId: base?.agentId ?? '(none)',
        liveAgentId: live.identity.agentId,
        text:
          `Concord: this server was launched as ${base?.agentId ?? 'an unnamed agent'} but ` +
          `the session hook for this client now reports ${live.identity.agentId} — the ` +
          'environment kept a session id a /resume or /clear replaced. Acting as the live one.',
      };
    }
    return live.identity;
  };

  const takeDriftAdvisory = (): DriftAdvisory | undefined => {
    const advisory = driftAdvisory;
    if (advisory === undefined) return undefined;
    driftAdvisory = undefined;
    driftAdvisoryShown = true;
    return advisory;
  };

  return { sessionForRequest, takeDriftAdvisory };
}
