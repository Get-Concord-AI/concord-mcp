import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';

describe('agent parent link', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('stores the parent agent on a child and returns it on read', () => {
    repos.agents.upsert({ agentId: 'claude-code:parent1', kind: 'claude-code' });
    const child = repos.agents.upsert({
      agentId: 'codex:child1',
      kind: 'codex',
      parentAgentId: 'claude-code:parent1',
    });
    expect(child.parentAgentId).toBe('claude-code:parent1');
    expect(repos.agents.get('codex:child1')?.parentAgentId).toBe('claude-code:parent1');
  });

  it('leaves parentAgentId null for top-level agents', () => {
    const agent = repos.agents.upsert({ agentId: 'claude-code:root', kind: 'claude-code' });
    expect(agent.parentAgentId).toBeNull();
  });

  it('keeps the stored parent when re-registering without one', () => {
    repos.agents.upsert({
      agentId: 'codex:child1',
      kind: 'codex',
      parentAgentId: 'claude-code:parent1',
    });
    const again = repos.agents.upsert({
      agentId: 'codex:child1',
      kind: 'codex',
      summary: 'now reviewing',
    });
    expect(again.parentAgentId).toBe('claude-code:parent1');
  });

  it('replaces the parent when a different one is given', () => {
    repos.agents.upsert({
      agentId: 'codex:child1',
      kind: 'codex',
      parentAgentId: 'claude-code:parent1',
    });
    const again = repos.agents.upsert({
      agentId: 'codex:child1',
      kind: 'codex',
      parentAgentId: 'claude-code:parent2',
    });
    expect(again.parentAgentId).toBe('claude-code:parent2');
  });

  it('clears the parent when explicitly set to null', () => {
    repos.agents.upsert({
      agentId: 'codex:child1',
      kind: 'codex',
      parentAgentId: 'claude-code:parent1',
    });
    const again = repos.agents.upsert({
      agentId: 'codex:child1',
      kind: 'codex',
      parentAgentId: null,
    });
    expect(again.parentAgentId).toBeNull();
  });
});
