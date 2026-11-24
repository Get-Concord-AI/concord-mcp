import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { userConcordDir } from '../config/user-config.js';
import type { Repositories, SessionBinding } from '../db/index.js';
import {
  liveSessionIdentity,
  resolveIdentity,
  UNRESOLVED_IDENTITY_MESSAGE,
  type AgentIdentity,
  type LiveSessionResolution,
  type ResolveIdentityOptions,
} from '../domain/identity.js';
import { ancestorChain, type AncestorProcess } from '../parent-chain.js';
import { isShellWrapper } from './session-binding.js';

/**
 * The CLI's view of the live session, for commands that outlive a `/resume`.
 *
 * A plugin monitor or `inbox watch` is spawned once with the session id its
 * client had at that moment. When the session is resumed or cleared inside the
 * same client process, the environment keeps the abandoned id while the
 * session-start hooks record the new one in `session_bindings` — the same
 * table the MCP server already consults through `liveSessionIdentity` (#366).
 * These helpers apply that correction to CLI drains and watchers, so a
 * surviving monitor keeps serving the session that is actually live.
 */

/**
 * How far up the process tree a CLI command looks for its bound client. The
 * walk stops at the first ancestor that is not a shell wrapper — the client
 * itself — the same boundary `recordClientBinding` writes to, so a session
 * started from another client's shell can never adopt the outer session's
 * binding while its own is still unrecorded.
 */
const LIVE_BINDING_DEPTH = 6;
/**
 * How long "no ancestor carries a binding" stands before the process table is
 * walked again. A monitor's drain processes share one ancestor list, so the
 * walk itself is rare; what repeats every poll are the sqlite lookups against
 * the cached pids, which also pick up bindings recorded after the walk.
 */
const NEGATIVE_CACHE_MS = 60_000;

/**
 * The monitor's start time in milliseconds since epoch, exported by
 * watch-inbox.sh. Each drain is a fresh process, so its own start time would
 * reject every binding written before the poll that happens to run —
 * including the one a `/resume` recorded while the monitor was already alive.
 * Millisecond precision matters: a whole-second floor reaches back into the
 * past and can adopt a binding that predates the monitor itself.
 */
const MONITOR_STARTED_AT_ENV = 'CONCORD_MONITOR_STARTED_AT';
/**
 * One id per monitor run, exported by watch-inbox.sh and inherited by every
 * drain it spawns. The ancestor cache is keyed by it: a second monitor — a
 * resumed session's replacement — must never reuse the first one's ancestry.
 */
const MONITOR_PID_ENV = 'CONCORD_MONITOR_PID';
/**
 * One random token per monitor launch, exported by watch-inbox.sh next to the
 * pid and start time. Pids get recycled; the token cannot be.
 */
const MONITOR_TOKEN_ENV = 'CONCORD_MONITOR_TOKEN';

/** Test seams: which ancestors to probe and where the discovery cache lives. */
export interface LiveIdentityDeps {
  ancestors?: () => AncestorProcess[];
  cacheDir?: string;
  now?: () => number;
}

/** What a payload-less CLI command acts as once live bindings are applied. */
export interface LiveAgentResolution {
  agentId: string;
  /** Env identity and the live binding named different agents. */
  drifted: boolean;
}

const ancestorCacheSchema = z.object({
  ancestorPids: z.array(z.number().int().positive()),
  startedAt: z.string(),
  walkedAt: z.string(),
});

interface AncestorCache {
  ancestorPids: number[];
  startedAtMs: number;
  walkedAtMs: number;
}

function nowMs(deps: LiveIdentityDeps): number {
  return deps.now?.() ?? Date.now();
}

/** When this process started — the freshness floor for adopted bindings. */
function processStartedAtMs(deps: LiveIdentityDeps): number {
  return nowMs(deps) - process.uptime() * 1000;
}

/**
 * The freshness floor for adopted bindings: when the monitor started, which
 * every drain it spawns inherits through the environment. A bare `inbox watch`
 * is its own monitor, so its process start is the floor; a one-shot drain has
 * no monitor lifetime to speak of and keeps its own.
 */
function monitorStartedAtMs(env: NodeJS.ProcessEnv, deps: LiveIdentityDeps): number {
  const raw = env[MONITOR_STARTED_AT_ENV]?.trim();
  if (raw !== undefined && raw !== '') {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return processStartedAtMs(deps);
}

/**
 * Which monitor this invocation serves: the per-launch token watch-inbox.sh
 * exports, else the exported pid plus start time, else this process's own
 * pid and start — which is what determines the ancestor chain anyway — for a
 * long-lived `inbox watch` and for drains nothing spawned on a monitor's
 * behalf. The pid alone is not enough: pids get recycled, and a new monitor
 * inheriting a dead one's cache entry would adopt its ancestry *and* its
 * freshness floor.
 */
/**
 * The `self:` instance id, computed once: its floor mixes the wall clock
 * with process uptime, so recomputing it per call can tick between polls —
 * and under a mocked clock it ticks every call, splitting the cache key.
 */
let selfInstanceIdMemo: string | undefined;

function selfInstanceId(deps: LiveIdentityDeps): string {
  selfInstanceIdMemo ??= `self:${String(process.pid)}:${String(Math.floor(processStartedAtMs(deps)))}`;
  return selfInstanceIdMemo;
}

export function monitorInstanceId(env: NodeJS.ProcessEnv, deps: LiveIdentityDeps = {}): string {
  const token = env[MONITOR_TOKEN_ENV]?.trim();
  if (token !== undefined && token !== '') return `token:${token}`;
  const pid = env[MONITOR_PID_ENV]?.trim();
  const started = env[MONITOR_STARTED_AT_ENV]?.trim();
  if ((pid !== undefined && pid !== '') || (started !== undefined && started !== '')) {
    return `env:${pid ?? ''}:${started ?? ''}`;
  }
  return selfInstanceId(deps);
}

/**
 * The discovery cache lives under `~/.concord/`, next to the machine-wide
 * store: a shared temp dir would let another local account plant a symlink at
 * the predictable path and have this process write through it.
 */
function cacheDirFor(deps: LiveIdentityDeps): string {
  return deps.cacheDir ?? join(userConcordDir(process.env), 'live-identity');
}

function cachePath(dir: string, key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return join(dir, `${hash}.json`);
}

function readAncestorCache(dir: string, key: string): AncestorCache | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(cachePath(dir, key), 'utf8'));
    const parsed = ancestorCacheSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const startedAtMs = Date.parse(parsed.data.startedAt);
    const walkedAtMs = Date.parse(parsed.data.walkedAt);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(walkedAtMs)) return undefined;
    return { ancestorPids: parsed.data.ancestorPids, startedAtMs, walkedAtMs };
  } catch {
    return undefined;
  }
}

/** Cache entries older than this are swept on the next write. */
const ANCESTOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function writeAncestorCache(
  dir: string,
  key: string,
  ancestorPids: number[],
  startedAtMs: number,
  walkedAtMs: number,
): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      cachePath(dir, key),
      JSON.stringify({
        ancestorPids,
        startedAt: new Date(startedAtMs).toISOString(),
        walkedAt: new Date(walkedAtMs).toISOString(),
      }),
    );
    // One file per repo/agent/monitor key would otherwise accumulate forever.
    const cutoff = walkedAtMs - ANCESTOR_CACHE_TTL_MS;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const file = join(dir, entry);
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      } catch {
        // A file that vanished or cannot be stat'ed is not worth failing over.
      }
    }
  } catch {
    // The cache is best-effort: a missed write costs one extra ancestor walk.
  }
}

/**
 * This process's ancestors, nearest first, up to and including the first
 * that is not a shell wrapper — the bound client. Anything deeper hosts
 * other clients' sessions, so it is never probed. Walked once per cache
 * period: on Windows each level is a `powershell` spawn, too expensive to
 * pay per poll. The full list is kept — not just the bound pid — so a
 * binding recorded for any of them later is found by the cheap per-poll
 * lookups.
 */
function boundAncestors(ancestors: readonly AncestorProcess[]): AncestorProcess[] {
  const bound: AncestorProcess[] = [];
  for (const ancestor of ancestors) {
    bound.push(ancestor);
    if (!isShellWrapper(ancestor.name)) break;
  }
  return bound;
}

function discoverAncestors(deps: LiveIdentityDeps): number[] {
  if (deps.ancestors !== undefined) {
    return boundAncestors(deps.ancestors()).map((ancestor) => ancestor.pid);
  }
  return ancestorChain(LIVE_BINDING_DEPTH, process.ppid, (a) => !isShellWrapper(a.name)).map(
    (ancestor) => ancestor.pid,
  );
}

/** A binding only counts when written while this monitor lived and its agent exists. */
function acceptableBinding(
  repos: Repositories,
  binding: SessionBinding,
  startedAtMs: number,
): SessionBinding | undefined {
  if (Date.parse(binding.updatedAt) < startedAtMs) return undefined;
  // Roster expiry is not session death: an idle resumed session archives while
  // its binding is still the client's live identity, so only a missing agent
  // row discards one — the same rule live-session.ts applies for the server.
  if (repos.agents.get(binding.agentId) === undefined) return undefined;
  return binding;
}

/**
 * The binding recorded for this process's client. The nearest ancestor with a
 * binding row names the session — the client itself or a wrapper shell below
 * it; deeper ancestors host other clients' sessions, so the first hit walking
 * up decides, stale row or not, exactly as `liveSession` resolves it.
 */
function bindingForPids(
  repos: Repositories,
  ancestorPids: readonly number[],
  startedAtMs: number,
): SessionBinding | undefined {
  for (const pid of ancestorPids) {
    const binding = repos.sessionBindings.forClientPid(pid);
    if (binding !== undefined) return acceptableBinding(repos, binding, startedAtMs);
  }
  return undefined;
}

/**
 * The binding recorded for this process's client, discovering the ancestor
 * pids once and caching them. Short-lived repeated invocations (the monitor's
 * drain loop spawns one process per poll) share the cache through their
 * parent pid's stable environment; the per-poll cost is one sqlite read per
 * cached ancestor, never a process-table walk.
 */
function discoverBinding(
  repos: Repositories,
  envIdentity: AgentIdentity,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  deps: LiveIdentityDeps,
): SessionBinding | undefined {
  const dir = cacheDirFor(deps);
  // Scoped to this monitor *instance*: another client's monitor for the same
  // agent must walk its own ancestry, never inherit a dead client's cached
  // pids — and a recycled pid must not hand a new monitor the old one's
  // ancestor list and freshness floor either. The v3 tag retires entries
  // written before the key carried the launch identity.
  const key = `${repoRoot}\n${envIdentity.agentId}\n${monitorInstanceId(env, deps)}\nv3`;
  const cached = readAncestorCache(dir, key);
  const startedAtMs = cached?.startedAtMs ?? monitorStartedAtMs(env, deps);
  const at = nowMs(deps);

  if (cached !== undefined) {
    const binding = bindingForPids(repos, cached.ancestorPids, startedAtMs);
    if (binding !== undefined) return binding;
    // Nothing bound yet: re-walk only once the negative answer has expired.
    // A binding that appears for a cached pid is still picked up above.
    if (at - cached.walkedAtMs < NEGATIVE_CACHE_MS) return undefined;
  }

  const ancestorPids = discoverAncestors(deps);
  writeAncestorCache(dir, key, ancestorPids, startedAtMs, at);
  return bindingForPids(repos, ancestorPids, startedAtMs);
}

/**
 * The env identity corrected by the session's live binding, mirroring
 * `liveSessionIdentity` on the server side. Skipped entirely when the
 * invocation already carries the live session — a hook payload names it — or
 * when an operator-chosen identity stays authoritative.
 */
function liveIdentityFor(
  repos: Repositories,
  envIdentity: AgentIdentity | undefined,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  options: ResolveIdentityOptions,
  deps: LiveIdentityDeps,
): LiveSessionResolution {
  if (
    envIdentity === undefined ||
    envIdentity.origin === 'operator' ||
    options.hookPayload !== undefined
  ) {
    return { identity: envIdentity, drifted: false };
  }
  const binding = discoverBinding(repos, envIdentity, repoRoot, env, deps);
  if (binding === undefined) return { identity: envIdentity, drifted: false };
  return liveSessionIdentity(envIdentity, binding);
}

/**
 * Which agent a payload-less CLI command acts as: the environment identity,
 * corrected by the binding the session's hooks recorded for this client when
 * one exists. Mirrors `resolveInboxOwner`'s contract — an explicit `--agent`
 * wins but must agree with the session's own identity — while letting a
 * `/resume` or `/clear` redirect a surviving monitor to the live agent.
 */
export function resolveLiveAgent(
  repos: Repositories,
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  options: ResolveIdentityOptions = {},
  deps: LiveIdentityDeps = {},
): LiveAgentResolution {
  const envIdentity = resolveIdentity(env, options);
  const live = liveIdentityFor(repos, envIdentity, repoRoot, env, options, deps);
  const own = live.identity;

  const given = explicit?.trim();
  const agentId = given !== undefined && given !== '' ? given : own?.agentId;
  if (agentId === undefined) {
    throw new Error(UNRESOLVED_IDENTITY_MESSAGE);
  }
  if (own !== undefined && own.agentId !== agentId) {
    throw new Error(
      `This session is agent ${own.agentId}; it cannot take messages addressed to ${agentId}.`,
    );
  }
  return { agentId, drifted: live.drifted };
}
