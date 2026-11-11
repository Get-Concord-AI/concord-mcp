import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  handleLocalKiroHook,
  isKiroHookEvent,
  kiroWorkspace,
  runKiroHook,
} from '../../src/cli/commands/kiro-hooks.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { agentIdForSession, type AgentIdentity } from '../../src/domain/identity.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

const KIRO: AgentIdentity = {
  agentId: agentIdForSession('kiro', 'kiro-session-1'),
  kind: 'kiro',
  origin: 'hook',
};

describe('Kiro hook events', () => {
  it('recognises only the events Concord installs', () => {
    expect(isKiroHookEvent('kiro-session-start')).toBe(true);
    expect(isKiroHookEvent('kiro-user-prompt-submit')).toBe(true);
    expect(isKiroHookEvent('kiro-stop')).toBe(true);
    expect(isKiroHookEvent('kiro-session-end')).toBe(false);
    expect(isKiroHookEvent('session-start')).toBe(false);
  });

  it("reads the workspace from the hook payload's cwd", () => {
    expect(kiroWorkspace(JSON.stringify({ cwd: '/work/app' }))).toBe('/work/app');
    expect(kiroWorkspace('{}')).toBe(process.cwd());
    expect(kiroWorkspace('{ not json')).toBe(process.cwd());
  });
});

describe('local Kiro hooks', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('registers the session and tells it the agent_id to pass, without listing itself', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });

    const message = handleLocalKiroHook(repos, KIRO, '/repo', 'kiro-session-start');

    expect(message).toContain(`agent_id: "${KIRO.agentId}"`);
    expect(message).toContain('codex:peer0001');
    expect(message).not.toContain(`- ${KIRO.agentId}`);
    expect(message).toContain('does not wake an idle session');
    expect(repos.agentEndpoints.getByAgent(KIRO.agentId)).toBeDefined();
  });

  it('injects a waiting message on the next prompt, once', () => {
    handleLocalKiroHook(repos, KIRO, '/repo', 'kiro-session-start');
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'codex:peer0001',
      toAgentId: KIRO.agentId,
      content: 'Reply with PINEAPPLE-42.',
      idempotencyKey: 'k-1',
    });

    expect(handleLocalKiroHook(repos, KIRO, '/repo', 'kiro-user-prompt-submit')).toContain(
      'PINEAPPLE-42',
    );
    expect(handleLocalKiroHook(repos, KIRO, '/repo', 'kiro-user-prompt-submit')).toBe('');
  });

  it('drains a message that arrived before the turn ended', () => {
    handleLocalKiroHook(repos, KIRO, '/repo', 'kiro-session-start');
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'codex:peer0001',
      toAgentId: KIRO.agentId,
      content: 'Late update before stop.',
      idempotencyKey: 'k-2',
    });

    expect(handleLocalKiroHook(repos, KIRO, '/repo', 'kiro-stop')).toContain('Late update');
    expect(handleLocalKiroHook(repos, KIRO, '/repo', 'kiro-stop')).toBe('');
  });
});

describe('runKiroHook', () => {
  it('derives the session identity from the stdin payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-kiro-hook-'));
    const output = await runKiroHook(
      'kiro-session-start',
      JSON.stringify({ session_id: 'kiro-session-1', cwd: root }),
      { HOME: root, PATH: '', USERPROFILE: root },
    );

    expect(output).toContain(`agent_id: "${KIRO.agentId}"`);
  });

  it('explains how to identify itself when the payload has no session id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-kiro-hook-'));
    const output = await runKiroHook('kiro-session-start', '{}', {
      HOME: root,
      PATH: '',
      USERPROFILE: root,
    });

    expect(output).toContain('concord inbox register');
  });

  it('adds nothing when another event cannot identify the session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-kiro-hook-'));
    expect(
      await runKiroHook('kiro-user-prompt-submit', '{}', {
        HOME: root,
        PATH: '',
        USERPROFILE: root,
      }),
    ).toBe('');
  });
});
