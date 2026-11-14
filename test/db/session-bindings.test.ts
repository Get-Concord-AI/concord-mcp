import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';

describe('session bindings', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('records which agent a client pid hosts, and reads it back', () => {
    repos.sessionBindings.upsert(1234, 'claude-code:aaaabbbb', 'claude-code');

    expect(repos.sessionBindings.forClientPid(1234)).toMatchObject({
      clientPid: 1234,
      agentId: 'claude-code:aaaabbbb',
      kind: 'claude-code',
    });
    expect(repos.sessionBindings.forClientPid(9999)).toBeUndefined();
  });

  it('overwrites the agent for a pid when the session changes', () => {
    repos.sessionBindings.upsert(1234, 'claude-code:aaaabbbb', 'claude-code');
    repos.sessionBindings.upsert(1234, 'claude-code:ccccdddd', 'claude-code');

    expect(repos.sessionBindings.forClientPid(1234)?.agentId).toBe('claude-code:ccccdddd');
  });

  it('refreshes every row an agent owns with touch', () => {
    repos.sessionBindings.upsert(10, 'claude-code:aaaabbbb', 'claude-code', '2026-01-01T00:00:00Z');
    repos.sessionBindings.upsert(11, 'claude-code:aaaabbbb', 'claude-code', '2026-01-01T00:00:00Z');
    repos.sessionBindings.upsert(12, 'claude-code:ccccdddd', 'claude-code', '2026-01-01T00:00:00Z');

    expect(repos.sessionBindings.touch('claude-code:aaaabbbb', '2026-06-01T00:00:00Z')).toBe(2);
    expect(repos.sessionBindings.forClientPid(10)?.updatedAt).toBe('2026-06-01T00:00:00Z');
    expect(repos.sessionBindings.forClientPid(12)?.updatedAt).toBe('2026-01-01T00:00:00Z');
    expect(repos.sessionBindings.touch('claude-code:eeeeffff')).toBe(0);
  });
});
