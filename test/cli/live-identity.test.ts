import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveLiveAgent, type LiveIdentityDeps } from '../../src/cli/live-identity.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { agentIdForSession } from '../../src/domain/identity.js';

const KIND = 'claude-code';
const ENV = { CLAUDE_CODE_SESSION_ID: 'spawned-session' };
const SPAWN_AGENT = agentIdForSession(KIND, 'spawned-session');
const LIVE_AGENT = 'claude-code:livebeef';
const CLIENT_PID = 4242;
const REPO_ROOT = 'C:\\concord-mcp';
const IDENTITY_OPTIONS = { kind: KIND };

function registerAgent(repos: Repositories, agentId: string): void {
  repos.agents.upsert({ agentId, kind: KIND });
}

function liveDeps(overrides: Partial<LiveIdentityDeps> = {}): LiveIdentityDeps {
  return {
    ancestors: () => [{ pid: CLIENT_PID, name: 'claude' }],
    cacheDir: mkdtempSync(join(tmpdir(), 'concord-live-id-')),
    ...overrides,
  };
}

describe('resolveLiveAgent', () => {
  let repos: Repositories;

  function freshRepos(): Repositories {
    return createRepositories(openDatabase(':memory:'));
  }

  it('keeps the environment identity when no binding exists', () => {
    repos = freshRepos();
    const result = resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, liveDeps());

    expect(result).toEqual({ agentId: SPAWN_AGENT, drifted: false });
  });

  it('follows the binding the session hooks recorded for this client', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);

    const result = resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, liveDeps());

    expect(result).toEqual({ agentId: LIVE_AGENT, drifted: true });
  });

  it('does not drift when the binding names the session the env already carries', () => {
    repos = freshRepos();
    registerAgent(repos, SPAWN_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, SPAWN_AGENT, KIND);

    const result = resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, liveDeps());

    expect(result).toEqual({ agentId: SPAWN_AGENT, drifted: false });
  });

  it('ignores a binding written before this monitor started', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    // The binding predates the watching process: it describes the session the
    // spawn-time environment already carries, not a /resume that happened since.
    repos.sessionBindings.upsert(
      CLIENT_PID,
      LIVE_AGENT,
      KIND,
      new Date(Date.now() - 86_400_000).toISOString(),
    );

    const result = resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, liveDeps());

    expect(result).toEqual({ agentId: SPAWN_AGENT, drifted: false });
  });

  it('ignores a binding whose agent is no longer registered', () => {
    repos = freshRepos();
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);

    const result = resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, liveDeps());

    expect(result).toEqual({ agentId: SPAWN_AGENT, drifted: false });
  });

  it('ignores a binding recorded for a different client kind', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, 'gemini');

    const result = resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, liveDeps());

    expect(result).toEqual({ agentId: SPAWN_AGENT, drifted: false });
  });

  it('keeps an operator-chosen identity authoritative without walking the process table', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);
    const walk = vi.fn(() => [{ pid: CLIENT_PID, name: 'claude' }]);

    const result = resolveLiveAgent(
      repos,
      undefined,
      { ...ENV, CONCORD_AGENT_ID: 'operator:chosen' },
      REPO_ROOT,
      IDENTITY_OPTIONS,
      liveDeps({ ancestors: walk }),
    );

    expect(result).toEqual({ agentId: 'operator:chosen', drifted: false });
    expect(walk).not.toHaveBeenCalled();
  });

  it('skips the binding lookup when a hook payload already names the session', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);
    const walk = vi.fn(() => [{ pid: CLIENT_PID, name: 'claude' }]);

    const result = resolveLiveAgent(
      repos,
      undefined,
      ENV,
      REPO_ROOT,
      { kind: KIND, hookPayload: '{"session_id":"hook-session"}' },
      liveDeps({ ancestors: walk }),
    );

    expect(result.agentId).toBe(agentIdForSession(KIND, 'hook-session'));
    expect(result.drifted).toBe(false);
    expect(walk).not.toHaveBeenCalled();
  });

  it('honours the skipBinding seam used by callers that already hold live truth', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);
    const walk = vi.fn(() => [{ pid: CLIENT_PID, name: 'claude' }]);

    const result = resolveLiveAgent(
      repos,
      undefined,
      ENV,
      REPO_ROOT,
      IDENTITY_OPTIONS,
      liveDeps({ ancestors: walk, skipBinding: true }),
    );

    expect(result).toEqual({ agentId: SPAWN_AGENT, drifted: false });
    expect(walk).not.toHaveBeenCalled();
  });

  it('rejects an explicit agent that disagrees with the live session', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);

    expect(() =>
      resolveLiveAgent(repos, 'other:agent', ENV, REPO_ROOT, IDENTITY_OPTIONS, liveDeps()),
    ).toThrow(/cannot take messages addressed to other:agent/);
  });

  it('accepts an explicit agent matching the live session', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);

    const result = resolveLiveAgent(
      repos,
      LIVE_AGENT,
      ENV,
      REPO_ROOT,
      IDENTITY_OPTIONS,
      liveDeps(),
    );

    expect(result).toEqual({ agentId: LIVE_AGENT, drifted: true });
  });

  it('throws when neither the environment nor an explicit flag names an agent', () => {
    repos = freshRepos();

    expect(() =>
      resolveLiveAgent(repos, undefined, {}, REPO_ROOT, IDENTITY_OPTIONS, liveDeps()),
    ).toThrow(/CONCORD_AGENT_ID/);
  });

  it('discovers the bound client pid once, then reuses the cache', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);
    const walk = vi.fn(() => [{ pid: CLIENT_PID, name: 'claude' }]);
    const deps = liveDeps({ ancestors: walk });

    // The monitor spawns one drain process per poll; each pays for the walk
    // at most once thanks to the shared cache.
    resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, deps);
    const second = resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, deps);

    expect(second).toEqual({ agentId: LIVE_AGENT, drifted: true });
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it('keeps the env identity when the binding row disappears, without re-walking', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);
    const walk = vi.fn(() => [{ pid: CLIENT_PID, name: 'claude' }]);
    const deps = liveDeps({ ancestors: walk });

    resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, deps);
    repos.sessionBindings.removeForAgent(LIVE_AGENT);
    const after = resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, deps);

    // The ancestor list is still valid: a binding re-recorded for the same
    // client pid is picked up by the per-poll lookup, no walk needed.
    expect(after).toEqual({ agentId: SPAWN_AGENT, drifted: false });
    expect(walk).toHaveBeenCalledTimes(1);

    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);
    const rebound = resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, deps);
    expect(rebound).toEqual({ agentId: LIVE_AGENT, drifted: true });
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it('lets a negative answer stand briefly instead of walking every poll', () => {
    repos = freshRepos();
    let at = 1_000_000;
    const walk = vi.fn(() => [{ pid: CLIENT_PID, name: 'claude' }]);
    const deps = liveDeps({ ancestors: walk, now: () => at });

    resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, deps);
    resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, deps);
    expect(walk).toHaveBeenCalledTimes(1);

    at += 61_000;
    resolveLiveAgent(repos, undefined, ENV, REPO_ROOT, IDENTITY_OPTIONS, deps);
    expect(walk).toHaveBeenCalledTimes(2);
  });

  it("never lets one monitor reuse another monitor's cached ancestors", () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(CLIENT_PID, LIVE_AGENT, KIND);
    const walk = vi.fn(() => [{ pid: CLIENT_PID, name: 'claude' }]);
    const deps = liveDeps({ ancestors: walk });
    const firstMonitor = { ...ENV, CONCORD_MONITOR_PID: '111' };
    const secondMonitor = { ...ENV, CONCORD_MONITOR_PID: '222' };

    // A resumed session's replacement monitor shares the agent id but has its
    // own process ancestry: it must walk, not inherit the dead monitor's pids.
    resolveLiveAgent(repos, undefined, firstMonitor, REPO_ROOT, IDENTITY_OPTIONS, deps);
    resolveLiveAgent(repos, undefined, secondMonitor, REPO_ROOT, IDENTITY_OPTIONS, deps);

    expect(walk).toHaveBeenCalledTimes(2);
  });

  it("takes the monitor start time as the freshness floor, not each drain's", () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    // Written while the monitor lived but before this drain process began:
    // exactly what a /resume records. The env-carried monitor start keeps it
    // acceptable even though the drain itself is newer than the binding.
    repos.sessionBindings.upsert(
      CLIENT_PID,
      LIVE_AGENT,
      KIND,
      new Date(Date.now() - 30_000).toISOString(),
    );
    const monitorEnv = {
      ...ENV,
      CONCORD_MONITOR_STARTED_AT: String(Date.now() - 120_000),
    };

    const result = resolveLiveAgent(
      repos,
      undefined,
      monitorEnv,
      REPO_ROOT,
      IDENTITY_OPTIONS,
      liveDeps(),
    );

    expect(result).toEqual({ agentId: LIVE_AGENT, drifted: true });
  });

  it('rejects a binding written before the monitor started, even within the same second', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    // Half a second before the monitor: a seconds-precision floor would still
    // reach it and adopt a binding that predates this monitor entirely.
    const monitorStart = Date.now();
    repos.sessionBindings.upsert(
      CLIENT_PID,
      LIVE_AGENT,
      KIND,
      new Date(monitorStart - 500).toISOString(),
    );
    const monitorEnv = {
      ...ENV,
      CONCORD_MONITOR_PID: '333',
      CONCORD_MONITOR_STARTED_AT: String(monitorStart),
    };

    const result = resolveLiveAgent(
      repos,
      undefined,
      monitorEnv,
      REPO_ROOT,
      IDENTITY_OPTIONS,
      liveDeps(),
    );

    expect(result).toEqual({ agentId: SPAWN_AGENT, drifted: false });
  });

  it('still rejects a binding older than the monitor itself', () => {
    repos = freshRepos();
    registerAgent(repos, LIVE_AGENT);
    repos.sessionBindings.upsert(
      CLIENT_PID,
      LIVE_AGENT,
      KIND,
      new Date(Date.now() - 3_600_000).toISOString(),
    );
    const monitorEnv = {
      ...ENV,
      CONCORD_MONITOR_STARTED_AT: String(Date.now() - 120_000),
    };

    const result = resolveLiveAgent(
      repos,
      undefined,
      monitorEnv,
      REPO_ROOT,
      IDENTITY_OPTIONS,
      liveDeps(),
    );

    expect(result).toEqual({ agentId: SPAWN_AGENT, drifted: false });
  });
});
