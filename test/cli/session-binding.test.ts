import { beforeEach, describe, expect, it } from 'vitest';

import { recordClientBinding } from '../../src/cli/session-binding.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';

const AGENT_A = { agentId: 'claude-code:aaaabbbb', kind: 'claude-code' };
const AGENT_B = { agentId: 'claude-code:ccccdddd', kind: 'claude-code' };

describe('recordClientBinding', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('binds every ancestor pid to the agent, so any of them resolves it', () => {
    recordClientBinding(repos, AGENT_A, [100, 200, 300]);

    for (const pid of [100, 200, 300]) {
      expect(repos.sessionBindings.forClientPid(pid)?.agentId).toBe(AGENT_A.agentId);
    }
  });

  it('re-binds the client when the session changes, dropping the old hook shell', () => {
    // A's hook ran inside shell 101 under client 100; B's inside shell 102.
    recordClientBinding(repos, AGENT_A, [101, 100]);
    recordClientBinding(repos, AGENT_B, [102, 100]);

    expect(repos.sessionBindings.forClientPid(100)?.agentId).toBe(AGENT_B.agentId);
    expect(repos.sessionBindings.forClientPid(101)?.agentId).toBe(AGENT_A.agentId);
    expect(repos.sessionBindings.forClientPid(102)?.agentId).toBe(AGENT_B.agentId);

    // Resuming A with a fresh shell must rebind client 100 to A — the stale
    // shell row alone must not satisfy the write.
    recordClientBinding(repos, AGENT_A, [103, 100]);

    expect(repos.sessionBindings.forClientPid(100)?.agentId).toBe(AGENT_A.agentId);
    expect(repos.sessionBindings.forClientPid(103)?.agentId).toBe(AGENT_A.agentId);
    // A's abandoned hook-shell row is gone: no dead pid keeps naming it.
    expect(repos.sessionBindings.forClientPid(101)).toBeUndefined();
    // B's own rows stay put until B records again.
    expect(repos.sessionBindings.forClientPid(102)?.agentId).toBe(AGENT_B.agentId);
  });

  it('re-records the same pids on a repeated fire', () => {
    recordClientBinding(repos, AGENT_A, [100]);
    repos.sessionBindings.touch(AGENT_A.agentId, '2026-01-01T00:00:00Z');

    recordClientBinding(repos, AGENT_A, [100, 200]);

    expect(repos.sessionBindings.forClientPid(100)?.updatedAt).not.toBe('2026-01-01T00:00:00Z');
    expect(repos.sessionBindings.forClientPid(200)?.agentId).toBe(AGENT_A.agentId);
  });
});
