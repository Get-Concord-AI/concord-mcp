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

  it('drops every row an agent owns with removeForAgent', () => {
    repos.sessionBindings.upsert(10, 'claude-code:aaaabbbb', 'claude-code');
    repos.sessionBindings.upsert(11, 'claude-code:aaaabbbb', 'claude-code');
    repos.sessionBindings.upsert(12, 'claude-code:ccccdddd', 'claude-code');

    expect(repos.sessionBindings.removeForAgent('claude-code:aaaabbbb')).toBe(2);
    expect(repos.sessionBindings.forClientPid(10)).toBeUndefined();
    expect(repos.sessionBindings.forClientPid(11)).toBeUndefined();
    expect(repos.sessionBindings.forClientPid(12)?.agentId).toBe('claude-code:ccccdddd');
    expect(repos.sessionBindings.removeForAgent('claude-code:eeeeffff')).toBe(0);
  });
});
