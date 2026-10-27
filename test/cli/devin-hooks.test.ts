import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CloudRuntime } from '../../src/cloud/runtime.js';
import {
  devinPromptSubmitOutput,
  handleCloudDevinHook,
  handleLocalDevinHook,
  isDevinHookEvent,
  runDevinHook,
} from '../../src/cli/commands/devin-hooks.js';
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

const DEVIN: AgentIdentity = {
  agentId: agentIdForSession('devin', 'devin-session-1'),
  kind: 'devin',
  origin: 'hook',
};
const NOW = new Date().toISOString();

describe('Devin hook events', () => {
  it('recognises only the events Concord installs', () => {
    expect(isDevinHookEvent('devin-session-start')).toBe(true);
    expect(isDevinHookEvent('devin-user-prompt-submit')).toBe(true);
    expect(isDevinHookEvent('devin-session-end')).toBe(true);
    expect(isDevinHookEvent('devin-stop')).toBe(false);
    expect(isDevinHookEvent('session-start')).toBe(false);
  });

  it('adds no context when the inbox is empty, since Devin rejects an empty block', () => {
    expect(devinPromptSubmitOutput([])).toBe('{}');
  });
});

describe('local Devin hooks', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('registers the session and tells it the agent_id to pass, without listing itself', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });

    const message = context(handleLocalDevinHook(repos, DEVIN, '/repo', 'devin-session-start'));

    expect(message).toContain(`agent_id: "${DEVIN.agentId}"`);
    expect(message).toContain('codex:peer0001');
    expect(message).not.toContain(`- ${DEVIN.agentId}`);
    expect(repos.agentEndpoints.getByAgent(DEVIN.agentId)).toBeDefined();
  });

  it('injects a waiting message on the next prompt, once', () => {
    handleLocalDevinHook(repos, DEVIN, '/repo', 'devin-session-start');
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'codex:peer0001',
      toAgentId: DEVIN.agentId,
      content: 'Reply with PINEAPPLE-42.',
      idempotencyKey: 'k-1',
    });

    expect(
      context(handleLocalDevinHook(repos, DEVIN, '/repo', 'devin-user-prompt-submit')),
    ).toContain('PINEAPPLE-42');
    expect(handleLocalDevinHook(repos, DEVIN, '/repo', 'devin-user-prompt-submit')).toBe('{}');
  });

  it('disconnects the endpoint at session end', () => {
    handleLocalDevinHook(repos, DEVIN, '/repo', 'devin-session-start');
    expect(handleLocalDevinHook(repos, DEVIN, '/repo', 'devin-session-end')).toBe('{}');
    expect(repos.agentEndpoints.getByAgent(DEVIN.agentId)?.status).not.toBe('connected');
  });
});

describe('cloud Devin hooks', () => {
  let repoRoot: string;
  let cloud: ReturnType<typeof fakeCloud>;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'concord-devin-cloud-'));
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
                agentKey: DEVIN.agentId,
                kind: 'devin',
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
      await handleCloudDevinHook(runtime, DEVIN, repoRoot, 'devin-session-start'),
    );

    const registered = JSON.stringify(
      cloud.requests.filter(
        (request) => request.path === '/v1/agents' && request.method === 'POST',
      ),
    );
    expect(registered).toContain(DEVIN.agentId);
    expect(registered).toContain('"kind":"devin"');
    expect(message).toContain(`agent_id: "${DEVIN.agentId}"`);
    expect(message).toContain('codex:bbbb2222');
    expect(message).not.toContain(`- ${DEVIN.agentId}`);
  });

  it('drains cloud messages into the prompt, and adds nothing when there are none', async () => {
    const message = {
      id: 'msg-1',
      senderAgentKey: 'codex:bbbb2222',
      taskKey: null,
      replyToMessageId: null,
      content: 'Cloud hello',
      createdAt: NOW,
      deliveredAt: NOW,
    };
    const withMail = runtimeWith([['POST /v1/messages/drain', () => ok({ messages: [message] })]]);
    expect(
      context(await handleCloudDevinHook(withMail, DEVIN, repoRoot, 'devin-user-prompt-submit')),
    ).toContain('Cloud hello');

    const empty = runtimeWith([['POST /v1/messages/drain', () => ok({ messages: [] })]]);
    expect(await handleCloudDevinHook(empty, DEVIN, repoRoot, 'devin-user-prompt-submit')).toBe(
      '{}',
    );
  });

  it('asks nothing of the cloud at session end', async () => {
    const runtime = runtimeWith([]);
    expect(await handleCloudDevinHook(runtime, DEVIN, repoRoot, 'devin-session-end')).toBe('{}');
    expect(cloud.requests).toEqual([]);
  });
});

describe('runDevinHook', () => {
  it('derives the agent from the Devin payload, not an inherited Claude Code session', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'concord-devin-run-'));
    const output = await runDevinHook(
      'devin-session-start',
      JSON.stringify({ session_id: 'devin-session-1' }),
      {
        HOME: process.env['HOME'],
        CLAUDE_CODE_SESSION_ID: 'claude-session',
        DEVIN_PROJECT_DIR: repoRoot,
      },
    );

    expect(context(output)).toContain(DEVIN.agentId);
  });

  it('adds nothing when the payload names no session', async () => {
    expect(await runDevinHook('devin-user-prompt-submit', '{}', {})).toBe('{}');
  });
});
