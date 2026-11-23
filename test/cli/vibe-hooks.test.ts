import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  handleLocalVibeHook,
  isVibeHookEvent,
  runVibeHook,
  vibeSessionStartOutput,
} from '../../src/cli/commands/vibe-hooks.js';
import { openContext } from '../../src/cli/context.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { agentIdForSession, type AgentIdentity } from '../../src/domain/identity.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

const hookOutput = z.object({
  hook_specific_output: z.object({
    additional_context: z.string(),
  }),
});

function context(output: string): string {
  return hookOutput.parse(JSON.parse(output)).hook_specific_output.additional_context;
}

const VIBE: AgentIdentity = {
  agentId: agentIdForSession('vibe', 'vibe-session-1'),
  kind: 'vibe',
  origin: 'hook',
};
const SESSION = 'vibe-session-1';

function payload(event: string, cwd: string, extra: Record<string, string> = {}): string {
  return JSON.stringify({
    hook_event_name: event,
    session_id: SESSION,
    cwd,
    parent_session_id: null,
    ...extra,
  });
}

describe('Vibe hook events', () => {
  it('recognises only the events Concord installs', () => {
    expect(isVibeHookEvent('vibe-session-start')).toBe(true);
    expect(isVibeHookEvent('vibe-session-end')).toBe(true);
    expect(isVibeHookEvent('devin-session-start')).toBe(false);
    expect(isVibeHookEvent('session-start')).toBe(false);
  });

  it('emits Vibe snake_case hook output', () => {
    const output = vibeSessionStartOutput('vibe:1234abcd', []);
    const parsed: unknown = JSON.parse(output);
    expect(hookOutput.parse(parsed).hook_specific_output.additional_context).toContain(
      'vibe:1234abcd',
    );
    expect(output).not.toContain('hookSpecificOutput');
    expect(context(output)).toContain('concord inbox drain --agent vibe:1234abcd --provider vibe');
  });
});

describe('local Vibe hooks', () => {
  let repos: Repositories;
  const repoRoot = '/repo';

  function freshRepos(): void {
    repos = createRepositories(openDatabase(':memory:'));
  }

  it('registers the session and tells it the agent_id to pass, without listing itself', () => {
    freshRepos();
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });

    const message = context(
      handleLocalVibeHook(
        repos,
        VIBE,
        repoRoot,
        'vibe-session-start',
        payload('session_start', repoRoot, { source: 'startup' }),
      ),
    );

    expect(message).toContain(`agent_id: "${VIBE.agentId}"`);
    expect(message).toContain('codex:peer0001');
    expect(message).not.toContain(`- ${VIBE.agentId}`);
    expect(repos.agentEndpoints.getByAgent(VIBE.agentId)).toBeDefined();
    expect(repos.agents.get(VIBE.agentId)?.kind).toBe('vibe');
  });

  it('disconnects the endpoint at session end', () => {
    freshRepos();
    handleLocalVibeHook(
      repos,
      VIBE,
      repoRoot,
      'vibe-session-start',
      payload('session_start', repoRoot),
    );
    expect(
      handleLocalVibeHook(
        repos,
        VIBE,
        repoRoot,
        'vibe-session-end',
        payload('session_end', repoRoot, { reason: 'exit' }),
      ),
    ).toBe('{}');
    expect(repos.agentEndpoints.getByAgent(VIBE.agentId)?.status).not.toBe('connected');
  });
});

describe('runVibeHook', () => {
  it('adds nothing when the payload names no session', async () => {
    expect(await runVibeHook('vibe-session-start', '{}', {})).toBe('{}');
    expect(await runVibeHook('vibe-session-end', 'not json', {})).toBe('{}');
  });

  it('derives the agent from the Vibe payload session_id in a temp workspace', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'concord-vibe-run-'));
    const output = await runVibeHook(
      'vibe-session-start',
      payload('session_start', repoRoot, { source: 'startup' }),
      { HOME: process.env['HOME'], CLAUDE_CODE_SESSION_ID: 'claude-session' },
    );

    expect(context(output)).toContain(VIBE.agentId);
  });

  it('gives subagent payloads no context and registers no agent', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'concord-vibe-sub-'));
    const env = { HOME: process.env['HOME'] };
    const child = payload('session_start', repoRoot, {
      session_id: 'child-session',
      parent_session_id: SESSION,
      source: 'startup',
    });

    expect(await runVibeHook('vibe-session-start', child, env)).toBe('{}');
    expect(await runVibeHook('vibe-session-end', child, env)).toBe('{}');

    const agents = openContext(repoRoot, env).repos.agents.list();
    expect(agents.filter((agent) => agent.kind === 'vibe')).toHaveLength(0);
  });
});
