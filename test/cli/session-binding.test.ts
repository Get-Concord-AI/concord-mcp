import { beforeEach, describe, expect, it } from 'vitest';

import {
  bindingTargetPids,
  isShellWrapper,
  recordClientBinding,
} from '../../src/cli/session-binding.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import type { AncestorProcess } from '../../src/parent-chain.js';

const AGENT_A = { agentId: 'claude-code:aaaabbbb', kind: 'claude-code' };
const AGENT_B = { agentId: 'claude-code:ccccdddd', kind: 'claude-code' };

const chain = (...entries: readonly [number, string][]): AncestorProcess[] =>
  entries.map(([pid, name]) => ({ pid, name }));

describe('isShellWrapper', () => {
  it('names the shells a harness puts between client and hook', () => {
    for (const name of [
      'sh',
      'bash',
      'zsh',
      'cmd.exe',
      'powershell.exe',
      'pwsh',
      'BASH',
      // `ps -o comm=` reports full paths on macOS, and login shells carry a `-`.
      '/bin/bash',
      '/usr/bin/zsh',
      '-zsh',
      'C:\\Windows\\System32\\cmd.exe',
    ]) {
      expect(isShellWrapper(name)).toBe(true);
    }
    for (const name of ['node', 'claude', 'code', '', 'fish-shell-helper']) {
      expect(isShellWrapper(name)).toBe(false);
    }
  });
});

describe('bindingTargetPids', () => {
  it('stops at the client: wrappers plus the first non-shell ancestor', () => {
    // hook -> cmd.exe -> claude -> bash -> outer claude
    expect(
      bindingTargetPids(chain([10, 'cmd.exe'], [20, 'claude'], [30, 'bash'], [40, 'claude'])),
    ).toEqual([10, 20]);
  });

  it('binds the client alone when the hook is spawned directly', () => {
    expect(bindingTargetPids(chain([20, 'claude'], [40, 'claude']))).toEqual([20]);
  });
});

describe('recordClientBinding', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('binds wrapper and client, never the client’s own parent', () => {
    // A nested session's hook chain: shell 11, inner client 12, then the
    // outer client's pid 30 and beyond. Rows must stop before 30 — binding it
    // would stamp the inner agent on the outer session's client.
    recordClientBinding(
      repos,
      AGENT_A,
      chain([11, 'sh'], [12, 'claude'], [30, 'bash'], [40, 'claude']),
    );

    expect(repos.sessionBindings.forClientPid(11)?.agentId).toBe(AGENT_A.agentId);
    expect(repos.sessionBindings.forClientPid(12)?.agentId).toBe(AGENT_A.agentId);
    expect(repos.sessionBindings.forClientPid(30)).toBeUndefined();
    expect(repos.sessionBindings.forClientPid(40)).toBeUndefined();
  });

  it('preserves an outer client’s binding when a nested session records', () => {
    recordClientBinding(repos, AGENT_A, chain([40, 'claude']));
    // A hook launched inside A's client: its chain shares A's pid but its
    // window ends at its own client 12.
    recordClientBinding(repos, AGENT_B, chain([11, 'sh'], [12, 'claude'], [40, 'claude']));

    expect(repos.sessionBindings.forClientPid(40)?.agentId).toBe(AGENT_A.agentId);
    expect(repos.sessionBindings.forClientPid(12)?.agentId).toBe(AGENT_B.agentId);
  });

  it('re-binds the client when the session changes, dropping the old hook shell', () => {
    // A's hook ran inside shell 101 under client 100; B's inside shell 102.
    recordClientBinding(repos, AGENT_A, chain([101, 'sh'], [100, 'claude']));
    recordClientBinding(repos, AGENT_B, chain([102, 'sh'], [100, 'claude']));

    expect(repos.sessionBindings.forClientPid(100)?.agentId).toBe(AGENT_B.agentId);
    expect(repos.sessionBindings.forClientPid(101)?.agentId).toBe(AGENT_A.agentId);
    expect(repos.sessionBindings.forClientPid(102)?.agentId).toBe(AGENT_B.agentId);

    // Resuming A with a fresh shell must rebind client 100 to A — the stale
    // shell row alone must not satisfy the write.
    recordClientBinding(repos, AGENT_A, chain([103, 'sh'], [100, 'claude']));

    expect(repos.sessionBindings.forClientPid(100)?.agentId).toBe(AGENT_A.agentId);
    expect(repos.sessionBindings.forClientPid(103)?.agentId).toBe(AGENT_A.agentId);
    // A's abandoned hook-shell row is gone: no dead pid keeps naming it.
    expect(repos.sessionBindings.forClientPid(101)).toBeUndefined();
    // B's own rows stay put until B records again.
    expect(repos.sessionBindings.forClientPid(102)?.agentId).toBe(AGENT_B.agentId);
  });

  it('re-records the same pids on a repeated fire', () => {
    recordClientBinding(repos, AGENT_A, chain([100, 'claude']));
    repos.sessionBindings.touch(AGENT_A.agentId, '2026-01-01T00:00:00Z');

    recordClientBinding(repos, AGENT_A, chain([100, 'claude'], [200, 'claude']));

    expect(repos.sessionBindings.forClientPid(100)?.updatedAt).not.toBe('2026-01-01T00:00:00Z');
    // 200 is the client's parent — outside the window, so no row is written.
    expect(repos.sessionBindings.forClientPid(200)).toBeUndefined();
  });
});
