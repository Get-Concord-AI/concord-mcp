import { beforeEach, describe, expect, it } from 'vitest';

import { recordClientBinding } from '../../src/cli/session-binding.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';

describe('recordClientBinding', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('binds every ancestor pid to the agent, so any of them resolves it', () => {
    recordClientBinding(
      repos,
      { agentId: 'claude-code:aaaabbbb', kind: 'claude-code' },
      [100, 200, 300],
    );

    for (const pid of [100, 200, 300]) {
      expect(repos.sessionBindings.forClientPid(pid)?.agentId).toBe('claude-code:aaaabbbb');
    }
  });

  it('re-binds the same pids when a /resume changes the agent', () => {
    recordClientBinding(
      repos,
      { agentId: 'claude-code:aaaabbbb', kind: 'claude-code' },
      [100, 200],
    );
    recordClientBinding(
      repos,
      { agentId: 'claude-code:ccccdddd', kind: 'claude-code' },
      [100, 200],
    );

    expect(repos.sessionBindings.forClientPid(100)?.agentId).toBe('claude-code:ccccdddd');
    expect(repos.sessionBindings.forClientPid(200)?.agentId).toBe('claude-code:ccccdddd');
  });

  it('touches existing rows instead of walking ancestors again', () => {
    repos.sessionBindings.upsert(
      100,
      'claude-code:aaaabbbb',
      'claude-code',
      '2026-01-01T00:00:00Z',
    );

    // Passing no pids proves the walk never ran: the touch path alone wins.
    recordClientBinding(repos, { agentId: 'claude-code:aaaabbbb', kind: 'claude-code' }, []);

    expect(repos.sessionBindings.forClientPid(100)?.agentId).toBe('claude-code:aaaabbbb');
    expect(repos.sessionBindings.forClientPid(100)?.updatedAt).not.toBe('2026-01-01T00:00:00Z');
  });
});
