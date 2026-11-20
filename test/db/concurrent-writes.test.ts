import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import { handleStartWork } from '../../src/tools/workflow.js';

describe('concurrent writers on one store', () => {
  it('start_work takes the write lock first, so a writer landing mid-transaction cannot fail it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'concord-concurrent-')), 'concord.db');
    const other = createRepositories(openDatabase(file));
    // The other process gives up at once instead of waiting, so the test stays fast.
    other.db.pragma('busy_timeout = 0');

    const repos = createRepositories(openDatabase(file));
    const agents = repos.agents;
    let interrupted = false;
    repos.agents = {
      ...agents,
      get: (agentId) => {
        const agent = agents.get(agentId);
        if (!interrupted) {
          interrupted = true;
          // Another process writes between this transaction's first read and its first write.
          try {
            handleRegisterAgent(other, { agent_id: 'codex:other', kind: 'codex' });
          } catch {
            // Expected while start_work holds the write lock: the other writer must wait.
          }
        }
        return agent;
      },
    };

    const result = handleStartWork(repos, {
      task_id: 'T1',
      title: 'Claim a file',
      kind: 'claude-code',
      agent_id: 'claude-code:me',
      expected_files: ['src/a.ts'],
    });
    expect(interrupted).toBe(true);
    expect(result.claim.task.taskId).toBe('T1');
  });
});
