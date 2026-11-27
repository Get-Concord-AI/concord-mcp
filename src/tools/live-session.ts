import type { Repositories, SessionBinding } from '../db/index.js';
import { SERVER_BINDING_DEPTH, ancestorPids } from '../parent-chain.js';
import {
  identityForRequest,
  liveSessionIdentity,
  type AgentIdentity,
  type LiveSessionBinding,
  type OpenCodeRequestIdentityMetadata,
} from '../domain/identity.js';

/** The one-time advisory produced when env and hook identities diverge. */
export interface DriftAdvisory {
  text: string;
  envAgentId: string;
  liveAgentId: string;
}

/** Test seams: which ancestors to probe and when this server started. */
export interface LiveSessionDeps {
  ancestors?: () => number[];
  startedAt?: number;
}

/**
 * The session a call acts as: the binding a session-start hook recorded for
 * this server's client when one exists — it reflects a `/resume` the
 * spawn-time environment never saw. Roster expiry does not lapse a binding:
 * an idle session archives while its client still hosts it. A row establishes
 * that proof only where its agent row exists; afterwards it is process-wide
 * client state, so a workspace whose store has no copy does not restore the
 * old identity. With no env identity to correct, the caller keeps its
 * unproven path.
 */
export function liveSession(
  session: AgentIdentity | undefined,
  requestIdentity:
    ((meta: OpenCodeRequestIdentityMetadata | undefined) => AgentIdentity | undefined) | undefined,
  deps: LiveSessionDeps = {},
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
  // The client's pid list is process-stable, so it is computed once. A server
  // trusts at most its parent and one shim past it: hooks bind the client and
  // its own wrappers only.
  const ancestors = deps.ancestors ?? ((): number[] => ancestorPids(SERVER_BINDING_DEPTH));
  const startedAt = deps.startedAt ?? Date.now() - process.uptime() * 1000;
  let candidates: number[] | undefined;
  let established: SessionBinding | undefined;
  const freshBindingIn = (callRepos: Repositories): SessionBinding | undefined => {
    candidates ??= ancestors();
    for (const pid of candidates) {
      const found = callRepos.sessionBindings.forClientPid(pid);
      if (found === undefined) continue;
      // The nearest bound ancestor names the client — but only a row written
      // while this server lived can correct its environment. An older row
      // belongs to a session that predates the server, whose identity the
      // spawn-time environment already carries; deeper pids host other
      // clients' sessions, so a stale row ends the search rather than
      // continuing it.
      return Date.parse(found.updatedAt) >= startedAt ? found : undefined;
    }
    return undefined;
  };
  const bindingFor = (callRepos: Repositories): LiveSessionBinding | undefined => {
    const found = freshBindingIn(callRepos);
    if (
      found !== undefined &&
      callRepos.agents.get(found.agentId) !== undefined &&
      (established === undefined || Date.parse(established.updatedAt) < Date.parse(found.updatedAt))
    ) {
      established = found;
    }
    return established;
  };

  const sessionForRequest = (
    callRepos: Repositories,
    meta: OpenCodeRequestIdentityMetadata | undefined,
  ): AgentIdentity | undefined => {
    const base = identityForRequest(session, requestIdentity?.(meta));
    const binding = bindingFor(callRepos);
    if (binding === undefined) return base;
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
