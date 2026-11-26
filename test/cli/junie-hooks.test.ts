import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CloudRuntime } from '../../src/cloud/runtime.js';
import {
  handleCloudJunieHook,
  handleLocalJunieHook,
  isJunieHookEvent,
  juniePromptSubmitOutput,
  junieRepoRoot,
  runJunieHook,
} from '../../src/cli/commands/junie-hooks.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { agentIdForSession, type AgentIdentity } from '../../src/domain/identity.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import { fakeCloud, ok, type Route } from '../cloud/fake-cloud.js';

const hookOutput = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.enum(['SessionStart', 'UserPromptSubmit']),
    additionalContext: z.string(),
  }),
});

function context(output: string): string {
  return hookOutput.parse(JSON.parse(output)).hookSpecificOutput.additionalContext;
}

const JUNIE: AgentIdentity = {
  agentId: agentIdForSession('junie', 'junie-session-1'),
  kind: 'junie',
  origin: 'hook',
};
const NOW = new Date().toISOString();

let markerDir: string;
beforeEach(() => {
  markerDir = mkdtempSync(join(tmpdir(), 'concord-junie-markers-'));
  process.env['CONCORD_HOOK_MARKER_DIR'] = markerDir;
  return () => {
    delete process.env['CONCORD_HOOK_MARKER_DIR'];
  };
});

describe('Junie hook events', () => {
  it('recognises only the events Concord installs', () => {
    expect(isJunieHookEvent('junie-session-start')).toBe(true);
    expect(isJunieHookEvent('junie-user-prompt-submit')).toBe(true);
    expect(isJunieHookEvent('junie-session-end')).toBe(true);
    expect(isJunieHookEvent('junie-stop')).toBe(false);
    expect(isJunieHookEvent('session-start')).toBe(false);
  });

  it('adds no context when the inbox is empty, since Junie rejects an empty block', () => {
    expect(juniePromptSubmitOutput([])).toBe('{}');
  });
});

describe('junieRepoRoot', () => {
  it('prefers the payload project_path over cwd and the process cwd', () => {
    const payload = JSON.stringify({
      hook_event_name: 'SessionStart',
      project_path: '/repo/project',
      cwd: '/repo/project/sub',
    });

    expect(junieRepoRoot(payload, '/fallback')).toBe('/repo/project');
  });

  it('falls back to cwd, then to the given fallback', () => {
    expect(junieRepoRoot(JSON.stringify({ cwd: '/repo/workdir' }), '/fallback')).toBe(
      '/repo/workdir',
    );
    expect(junieRepoRoot('{}', '/fallback')).toBe('/fallback');
    expect(junieRepoRoot('not json', '/fallback')).toBe('/fallback');
  });
});

describe('local Junie hooks', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('registers the session and tells it the Junie agent_id to pass', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });

    const message = context(handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-session-start'));

    expect(message).toContain(`agent_id: "${JUNIE.agentId}"`);
    expect(message).toContain("Junie's MCP server cannot see the hook session payload");
    expect(message).toContain('--provider junie');
    expect(message).toContain('codex:peer0001');
    expect(repos.agentEndpoints.getByAgent(JUNIE.agentId)).toBeDefined();
  });

  it('injects a waiting message on the next prompt, once', () => {
    handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-session-start');
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'codex:peer0001',
      toAgentId: JUNIE.agentId,
      content: 'Reply with PINEAPPLE-42.',
      idempotencyKey: 'k-1',
    });

    expect(
      context(handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-user-prompt-submit')),
    ).toContain('PINEAPPLE-42');
    expect(handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-user-prompt-submit')).toBe('{}');
  });

  it('disconnects the endpoint at session end', () => {
    handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-session-start');
    expect(handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-session-end')).toBe('{}');
    expect(repos.agentEndpoints.getByAgent(JUNIE.agentId)?.status).not.toBe('connected');
  });
});

describe('cloud Junie hooks', () => {
  let repoRoot: string;
  let cloud: ReturnType<typeof fakeCloud>;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'concord-junie-cloud-'));
  });

  const registration: Route[] = [
    ['POST /v1/machines', () => ok({ machine: { id: 'm-uuid' } })],
    ['POST /v1/agents', () => ok({ agent: { id: 'a-uuid' } })],
    ['PUT /v1/agents/a-uuid/endpoint', () => ok({ endpoint: {} })],
  ];

  function runtimeWith(routes: Route[]): CloudRuntime {
    cloud = fakeCloud([...registration, ...routes]);
    return {
      apiUrl: 'https://api.example.test',
      bearer: () => Promise.resolve('token'),
      machineKey: 'machine-1',
      projectKey: 'github.com/acme/app',
      repoRoot,
      checkoutRoot: repoRoot,
      fetch: cloud.fetch,
    };
  }

  it('registers the session in the cloud and names the organization, not itself', async () => {
    const runtime = runtimeWith([
      [
        'GET /v1/agents',
        () =>
          ok({
            agents: [
              {
                id: 'self-uuid',
                agentKey: JUNIE.agentId,
                kind: 'junie',
                summary: null,
                status: 'active',
                lastSeenAt: NOW,
              },
              {
                id: 'peer-uuid',
                agentKey: 'codex:bbbb2222',
                kind: 'codex',
                summary: 'busy',
                status: 'active',
                lastSeenAt: NOW,
              },
            ],
          }),
      ],
    ]);

    const message = context(
      await handleCloudJunieHook(runtime, JUNIE, repoRoot, 'junie-session-start'),
    );

    const registered = JSON.stringify(
      cloud.requests.filter(
        (request) => request.path === '/v1/agents' && request.method === 'POST',
      ),
    );
    expect(registered).toContain(JUNIE.agentId);
    expect(registered).toContain('"kind":"junie"');
    expect(message).toContain(`agent_id: "${JUNIE.agentId}"`);
    expect(message).toContain('codex:bbbb2222');
    expect(message).not.toContain(`- ${JUNIE.agentId}`);
  });

  it('briefs the first cloud prompt submit and not the second', async () => {
    const runtime = runtimeWith([
      [
        'GET /v1/agents',
        () =>
          ok({
            agents: [
              {
                id: 'self-uuid',
                agentKey: JUNIE.agentId,
                kind: 'junie',
                summary: null,
                status: 'active',
                lastSeenAt: NOW,
              },
              {
                id: 'peer-uuid',
                agentKey: 'codex:bbbb2222',
                kind: 'codex',
                summary: 'busy',
                status: 'active',
                lastSeenAt: NOW,
              },
            ],
          }),
      ],
      ['POST /v1/messages/drain', () => ok({ messages: [] })],
    ]);
    const explicitMarkerDir = mkdtempSync(join(tmpdir(), 'concord-junie-explicit-markers-'));
    const env = { CONCORD_HOOK_MARKER_DIR: explicitMarkerDir };

    const first = context(
      await handleCloudJunieHook(runtime, JUNIE, repoRoot, 'junie-user-prompt-submit', env),
    );

    expect(first).toContain(`agent_id: "${JUNIE.agentId}"`);
    expect(first).toContain("Junie's MCP server cannot see the hook session payload");
    expect(first).toContain('codex:bbbb2222');
    expect(
      await handleCloudJunieHook(runtime, JUNIE, repoRoot, 'junie-user-prompt-submit', env),
    ).toBe('{}');
    expect(readdirSync(explicitMarkerDir)).toHaveLength(1);
    expect(readdirSync(markerDir)).toEqual([]);
    expect(cloud.requests.filter((request) => request.path === '/v1/messages/drain')).toHaveLength(
      2,
    );
  });

  it('does not drain or mark the briefing when the cloud roster fails', async () => {
    const runtime = runtimeWith([
      ['GET /v1/agents', () => ({ status: 500, json: { error: 'unavailable' } })],
      ['POST /v1/messages/drain', () => ok({ messages: [] })],
    ]);
    const env = { CONCORD_HOOK_MARKER_DIR: markerDir };

    await expect(
      handleCloudJunieHook(runtime, JUNIE, repoRoot, 'junie-user-prompt-submit', env),
    ).rejects.toThrow();
    expect(cloud.requests.some((request) => request.path === '/v1/messages/drain')).toBe(false);
    expect(readdirSync(markerDir)).toEqual([]);
  });

  it('asks nothing of the cloud at session end', async () => {
    const runtime = runtimeWith([]);
    expect(await handleCloudJunieHook(runtime, JUNIE, repoRoot, 'junie-session-end')).toBe('{}');
    expect(cloud.requests).toEqual([]);
  });
});

describe('runJunieHook', () => {
  it('derives the agent from the Junie payload and repo from project_path', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'concord-junie-run-'));
    const output = await runJunieHook(
      'junie-session-start',
      JSON.stringify({
        session_id: 'junie-session-1',
        project_path: repoRoot,
        cwd: '/somewhere/else',
      }),
      { HOME: process.env['HOME'] },
    );

    expect(context(output)).toContain(JUNIE.agentId);
  });

  it('adds nothing when the payload names no session — SessionEnd carries only reason', async () => {
    expect(await runJunieHook('junie-session-end', '{"reason":"prompt_input_exit"}', {})).toBe(
      '{}',
    );
  });
});

describe('first-prompt identity briefing (SessionStart context is dropped by Junie)', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('briefs the session on its first prompt submit even when the inbox is empty', () => {
    handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-session-start');

    const first = context(handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-user-prompt-submit'));

    expect(first).toContain(`agent_id: "${JUNIE.agentId}"`);
    expect(first).toContain("Junie's MCP server cannot see the hook session payload");
  });

  it('briefs once per session: the second prompt submit carries no identity text', () => {
    handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-session-start');
    handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-user-prompt-submit');

    expect(handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-user-prompt-submit')).toBe('{}');
  });

  it('leads with the briefing and appends drained messages on the same first prompt', () => {
    handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-session-start');
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'codex:peer0001',
      toAgentId: JUNIE.agentId,
      content: 'Reply with PINEAPPLE-42.',
      idempotencyKey: 'k-brief',
    });

    const first = context(handleLocalJunieHook(repos, JUNIE, '/repo', 'junie-user-prompt-submit'));

    expect(first).toContain(`agent_id: "${JUNIE.agentId}"`);
    expect(first).toContain('PINEAPPLE-42');
    expect(first.indexOf('agent_id')).toBeLessThan(first.indexOf('PINEAPPLE-42'));
  });

  it('does not brief harnesses without the flag even on a first prompt', () => {
    // devin shares the runner but its SessionStart context lands fine.
    const output = juniePromptSubmitOutput([]);
    expect(output).toBe('{}');
  });
});
