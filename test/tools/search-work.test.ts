import { beforeEach, describe, expect, it } from 'vitest';

import { registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleHandoff } from '../../src/tools/handoff.js';
import { handleInspectWork } from '../../src/tools/inspect-work.js';
import { snippetOf, type SearchView } from '../../src/tools/search-work.js';
import { handleUpdateTask } from '../../src/tools/update-task.js';

function registerAgent(repos: Repositories, agentId: string): void {
  repos.agents.upsert({
    agentId,
    kind: 'claude-code',
    owner: null,
    model: null,
    pid: null,
    cwd: null,
    worktree: null,
    branch: null,
    summary: null,
    status: 'active',
  });
  registerPullEndpoint(repos, agentId, 'claude-code');
}

describe('inspect_work query', () => {
  let repos: Repositories;
  let messageId: string;

  const search = (args: { query: string; limit?: number }, viewer?: string): SearchView => {
    const result = handleInspectWork(repos, args, viewer);
    if (result.scope !== 'search') throw new Error(`expected search, got ${result.scope}`);
    return result;
  };

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    for (const agent of ['alpha', 'beta', 'gamma']) registerAgent(repos, agent);
    handleClaimWork(repos, {
      task_id: 'TASK-1',
      title: 'Cache',
      agent: 'alpha',
      agent_id: 'alpha',
      expected_files: ['src/cache.ts'],
    });
    handleUpdateTask(repos, {
      task_id: 'TASK-1',
      kind: 'finding',
      content: 'The Bluebird cache drops writes under load; 100% reproducible.',
      agent_id: 'alpha',
    });
    handleHandoff(repos, {
      task_id: 'TASK-1',
      agent_id: 'alpha',
      status: 'active',
      what_changed: 'Investigated the cache',
      next_steps: ['Patch the zephyr eviction path'],
    });
    messageId = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'beta',
      content: 'Have you seen the kestrel timeout before?',
      idempotencyKey: 'k1',
    }).message.messageId;
  });

  it('finds a finding case-insensitively and names the task to open', () => {
    expect(search({ query: 'bluebird' }, 'alpha').results).toEqual([
      expect.objectContaining({ source: 'update', taskId: 'TASK-1', kind: 'finding' }),
    ]);
  });

  it('finds a handoff by its next steps, showing the step that matched', () => {
    const [hit] = search({ query: 'zephyr' }, 'alpha').results;
    expect(hit).toMatchObject({ source: 'handoff', taskId: 'TASK-1' });
    expect(hit?.snippet).toMatch(/^Patch the zephyr/u);
  });

  it('finds a message only for its sender and recipient, without marking it read', () => {
    for (const viewer of ['alpha', 'beta']) {
      expect(search({ query: 'kestrel' }, viewer).results).toEqual([
        expect.objectContaining({ source: 'message', messageId }),
      ]);
    }
    expect(search({ query: 'kestrel' }, 'gamma').results).toEqual([]);
    expect(search({ query: 'kestrel' }).results).toEqual([]);
    expect(repos.agentMessages.get(messageId)?.readAt).toBeNull();
  });

  it('treats LIKE wildcards as characters and JSON syntax as no match', () => {
    expect(search({ query: '100%' }, 'alpha').results).toHaveLength(1);
    expect(search({ query: '_' }, 'alpha').results).toHaveLength(0);
    expect(search({ query: 'zephyr eviction path"' }, 'alpha').results).toHaveLength(0);
  });

  it('caps results at limit, newest first', () => {
    const results = search({ query: 'e', limit: 2 }, 'alpha').results;
    expect(results).toHaveLength(2);
    expect(results[0]?.source).toBe('message');
  });

  it('refuses query beside another selector, and limit without query', () => {
    expect(() => handleInspectWork(repos, { query: 'x', task_id: 'TASK-1' })).toThrow(/only one/u);
    expect(() => handleInspectWork(repos, { limit: 3 })).toThrow(/only with query/u);
  });

  it('cuts long snippets around the match by code point', () => {
    const text = `${'😀'.repeat(300)} needle ${'x'.repeat(300)}`;
    const snippet = snippetOf(text, 'needle');
    expect(snippet).toContain('needle');
    expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});
