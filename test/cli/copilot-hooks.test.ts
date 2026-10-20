import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  copilotWorkspace,
  localCopilotBackend,
  runCopilotHook,
  type CopilotHookBackend,
} from '../../src/cli/commands/copilot-hooks.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { agentIdForSession, resolveIdentity } from '../../src/domain/identity.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

const SESSION = '4cb194b8-a1db-4a30-b504-0a3db3e2a222';
const AGENT_ID = agentIdForSession('copilot-cli', SESSION);
const payload = (extra: Record<string, string> = {}): string =>
  JSON.stringify({ sessionId: SESSION, timestamp: 1, cwd: '/repo', ...extra });

const contextSchema = z.object({ additionalContext: z.string().optional() }).strict();
const stopSchema = z.object({ decision: z.string().optional(), reason: z.string().optional() });

async function hook(backend: CopilotHookBackend, event: string, raw: string): Promise<string> {
  const output = await runCopilotHook(backend, event, raw);
  if (output === undefined) throw new Error(`no output for ${event}`);
  return output;
}

function sendTo(repos: Repositories, content: string, key: string): void {
  handleRegisterAgent(repos, { agent_id: 'claude:sender', kind: 'claude-code' });
  handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: 'claude:sender',
    toAgentId: AGENT_ID,
    content,
    idempotencyKey: key,
  });
}

describe('Copilot CLI hooks', () => {
  let repos: Repositories;
  let backend: CopilotHookBackend;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    backend = localCopilotBackend(repos, '/repo');
  });

  it('derives the same agent id the MCP server resolves from COPILOT_AGENT_SESSION_ID', () => {
    const server = resolveIdentity(
      { COPILOT_AGENT_SESSION_ID: SESSION, CLAUDE_CODE_SESSION_ID: 'parent' },
      { kind: 'copilot-cli' },
    );
    expect(server?.agentId).toBe(AGENT_ID);
  });

  it('registers the session at start and tells it its identity', async () => {
    const output = contextSchema.parse(JSON.parse(await hook(backend, 'session-start', payload())));
    expect(output.additionalContext).toContain(AGENT_ID);
    expect(repos.agents.get(AGENT_ID)?.kind).toBe('copilot-cli');
    expect(repos.agents.get(AGENT_ID)?.cwd).toBe('/repo');
    expect(repos.agentEndpoints.getByAgent(AGENT_ID)?.provider).toBe('copilot-cli');
  });

  it('says it cannot identify a session whose payload has no id', async () => {
    const output = contextSchema.parse(JSON.parse(await hook(backend, 'session-start', '{}')));
    expect(output.additionalContext).toContain('Concord cannot tell which session you are');
  });

  it('delivers waiting messages after a tool call, once', async () => {
    await hook(backend, 'session-start', payload());
    sendTo(repos, 'Review the latest diff please.', 'k-1');

    const first = contextSchema.parse(JSON.parse(await hook(backend, 'post-tool-use', payload())));
    expect(first.additionalContext).toContain('Review the latest diff please.');
    expect(first.additionalContext).toContain('claude:sender');
    expect(JSON.parse(await hook(backend, 'post-tool-use', payload()))).toEqual({});
  });

  it('keeps tool-hook context under Copilot’s 10 KB cap', async () => {
    await hook(backend, 'session-start', payload());
    sendTo(repos, 'x'.repeat(12_000), 'k-big');
    const output = contextSchema.parse(JSON.parse(await hook(backend, 'post-tool-use', payload())));
    expect(output.additionalContext?.length).toBeLessThan(10_000);
    expect(output.additionalContext).toContain('Truncated');
  });

  it('blocks the stop so a late message becomes the next turn', async () => {
    await hook(backend, 'session-start', payload());
    expect(JSON.parse(await hook(backend, 'stop', payload()))).toEqual({});

    sendTo(repos, 'Wait, one more thing!', 'k-2');
    const output = stopSchema.parse(JSON.parse(await hook(backend, 'stop', payload())));
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('Wait, one more thing!');
  });

  it('never fails the session when the backend does', async () => {
    const failing: CopilotHookBackend = {
      register: () => Promise.reject(new Error('down')),
      roster: () => Promise.resolve([]),
      drain: () => Promise.reject(new Error('down')),
      startLiveHost: () => undefined,
    };
    const start = contextSchema.parse(JSON.parse(await hook(failing, 'session-start', payload())));
    expect(start.additionalContext).toContain('down');
    expect(JSON.parse(await hook(failing, 'post-tool-use', payload()))).toEqual({});
    expect(JSON.parse(await hook(failing, 'stop', payload()))).toEqual({});
  });

  it('starts a live host only for sessions the launcher started (#261)', async () => {
    const hosts: string[][] = [];
    const recording: CopilotHookBackend = {
      register: () => Promise.resolve(),
      roster: () => Promise.resolve([]),
      drain: () => Promise.resolve([]),
      startLiveHost: (agentId, sessionId, address) => {
        hosts.push([agentId, sessionId, address]);
      },
    };
    await runCopilotHook(recording, 'session-start', payload());
    expect(hosts).toEqual([]);

    await runCopilotHook(recording, 'session-start', payload(), '127.0.0.1:47125');
    expect(hosts).toEqual([[AGENT_ID, SESSION, '127.0.0.1:47125']]);
  });

  it('reports an unknown event as unhandled', async () => {
    expect(await runCopilotHook(backend, 'pre-compact', payload())).toBeUndefined();
  });
});

describe('copilotWorkspace', () => {
  it('reads the payload cwd, falling back to the process cwd', () => {
    expect(copilotWorkspace(payload())).toBe('/repo');
    expect(copilotWorkspace('not json')).toBe(process.cwd());
    expect(copilotWorkspace('{}')).toBe(process.cwd());
  });
});
