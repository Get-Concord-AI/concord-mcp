import { beforeEach, describe, expect, it } from 'vitest';

import {
  decidePreToolUse,
  handleSessionStart,
  sessionStartAgentId,
} from '../../src/cli/commands/hook.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

function preToolUse(filePath: string): string {
  return JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } });
}

describe('decidePreToolUse', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('allows edits to files no other task has claimed', () => {
    handleClaimWork(repos, { task_id: 'T1', title: 'Other', expected_files: ['src/a.ts'] });
    const decision = decidePreToolUse(repos, preToolUse('src/b.ts'), 'MINE');
    expect(decision.block).toBe(false);
    expect(decision.message).toBe('');
  });

  it('blocks an edit to a file claimed by another active task', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Owns app', expected_files: ['src/app.ts'] });
    const decision = decidePreToolUse(repos, preToolUse('src/app.ts'), 'MINE');
    expect(decision.block).toBe(true);
    expect(decision.message).toContain('OTHER');
  });

  it('does not block your own claimed file when CONCORD_TASK matches', () => {
    handleClaimWork(repos, { task_id: 'MINE', title: 'Mine', expected_files: ['src/app.ts'] });
    expect(decidePreToolUse(repos, preToolUse('src/app.ts'), 'MINE').block).toBe(false);
  });

  it('advises but does not block when the task id is unknown', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Owns', expected_files: ['src/app.ts'] });
    const decision = decidePreToolUse(repos, preToolUse('src/app.ts'), undefined);
    expect(decision.block).toBe(false);
    expect(decision.message).toContain('CONCORD_TASK');
  });

  it('allows when there is no file path or the payload is malformed', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Owns', expected_files: ['src/app.ts'] });
    expect(
      decidePreToolUse(repos, JSON.stringify({ tool_name: 'Bash', tool_input: {} }), 'MINE').block,
    ).toBe(false);
    expect(decidePreToolUse(repos, 'not valid json', 'MINE').block).toBe(false);
  });
});

describe('sessionStartAgentId', () => {
  it('derives a stable id from the session id', () => {
    expect(sessionStartAgentId('a1b2c3d4-e5f6-7890')).toBe('claude-code:a1b2c3d4');
  });

  it('falls back to a random suffix when no session id is given', () => {
    expect(sessionStartAgentId(undefined)).toMatch(/^claude-code:[0-9a-f]{8}$/);
  });
});

describe('handleSessionStart', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('registers the session as an agent and reports its id', () => {
    const result = handleSessionStart(
      repos,
      JSON.stringify({ session_id: 'a1b2c3d4-e5f6', cwd: '/repo' }),
    );
    expect(result.agentId).toBe('claude-code:a1b2c3d4');
    expect(result.message).toContain('claude-code:a1b2c3d4');
    expect(result.message).toContain('No other agents');
    expect(repos.agents.get('claude-code:a1b2c3d4')?.cwd).toBe('/repo');
  });

  it('is idempotent for the same session and lists other present agents', () => {
    handleRegisterAgent(repos, {
      agent_id: 'codex:9q2r',
      kind: 'codex',
      summary: 'building the backend',
    });
    const payload = JSON.stringify({ session_id: 'a1b2c3d4' });
    handleSessionStart(repos, payload);
    const again = handleSessionStart(repos, payload);
    expect(repos.agents.list()).toHaveLength(2);
    expect(again.message).toContain('codex:9q2r');
    expect(again.message).toContain('building the backend');
  });

  it('tolerates a malformed payload by generating a random id', () => {
    const result = handleSessionStart(repos, 'not json');
    expect(result.agentId).toMatch(/^claude-code:[0-9a-f]{8}$/);
  });
});
