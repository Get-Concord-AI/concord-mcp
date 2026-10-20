import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  copilotWorkspace,
  fittingPrefix,
  localCopilotBackend,
  runCopilotHook,
  type CopilotHookBackend,
  type CopilotHookContext,
} from '../../src/cli/commands/copilot-hooks.js';
import type { MessageSpool } from '../../src/cli/commands/copilot-spool.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { agentIdForSession, resolveIdentity } from '../../src/domain/identity.js';
import type { DeliverableMessage } from '../../src/domain/pull-inbox.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

const SESSION = '4cb194b8-a1db-4a30-b504-0a3db3e2a222';
const AGENT_ID = agentIdForSession('copilot-cli', SESSION);
const payload = (extra: Record<string, string> = {}): string =>
  JSON.stringify({ sessionId: SESSION, timestamp: 1, cwd: '/repo', ...extra });

const contextSchema = z.object({ additionalContext: z.string().optional() }).strict();
const stopSchema = z.object({ decision: z.string().optional(), reason: z.string().optional() });

function memorySpool(): MessageSpool {
  const store = new Map<string, DeliverableMessage[]>();
  return {
    take: (agentId) => {
      const messages = store.get(agentId) ?? [];
      store.delete(agentId);
      return messages;
    },
    put: (agentId, messages) => {
      if (messages.length > 0) store.set(agentId, [...messages]);
    },
  };
}

function context(
  backend: CopilotHookBackend,
  extra: Partial<CopilotHookContext> = {},
): CopilotHookContext {
  return { backend, spool: memorySpool(), env: {}, ...extra };
}

async function hook(ctx: CopilotHookContext, event: string, raw = payload()): Promise<string> {
  const output = await runCopilotHook(ctx, event, raw);
  if (output === undefined) throw new Error(`no output for ${event}`);
  return output;
}

const shownContext = async (ctx: CopilotHookContext): Promise<string | undefined> =>
  contextSchema.parse(JSON.parse(await hook(ctx, 'post-tool-use'))).additionalContext;

function sendTo(repos: Repositories, content: string, key: string, to = AGENT_ID): void {
  handleRegisterAgent(repos, { agent_id: 'claude:sender', kind: 'claude-code' });
  handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: 'claude:sender',
    toAgentId: to,
    content,
    idempotencyKey: key,
  });
}

describe('Copilot CLI hooks', () => {
  let repos: Repositories;
  let ctx: CopilotHookContext;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    ctx = context(localCopilotBackend(repos, '/repo'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the same agent id the MCP server resolves from COPILOT_AGENT_SESSION_ID', () => {
    const server = resolveIdentity(
      { COPILOT_AGENT_SESSION_ID: SESSION, CLAUDE_CODE_SESSION_ID: 'parent' },
      { kind: 'copilot-cli' },
    );
    expect(server?.agentId).toBe(AGENT_ID);
  });

  it('registers the session at start and tells it its identity', async () => {
    const output = contextSchema.parse(JSON.parse(await hook(ctx, 'session-start')));
    expect(output.additionalContext).toContain(AGENT_ID);
    expect(repos.agents.get(AGENT_ID)?.kind).toBe('copilot-cli');
    expect(repos.agents.get(AGENT_ID)?.cwd).toBe('/repo');
    expect(repos.agentEndpoints.getByAgent(AGENT_ID)?.provider).toBe('copilot-cli');
  });

  it('acts as CONCORD_AGENT_ID when the operator named the session, as the MCP server does', async () => {
    ctx = context(localCopilotBackend(repos, '/repo'), { env: { CONCORD_AGENT_ID: 'alpha' } });
    await hook(ctx, 'session-start');
    expect(repos.agents.get('alpha')).toBeDefined();
    expect(repos.agents.get(AGENT_ID)).toBeUndefined();

    sendTo(repos, 'For alpha.', 'k-alpha', 'alpha');
    expect(await shownContext(ctx)).toContain('For alpha.');
  });

  it('says it cannot identify a session whose payload has no id', async () => {
    const output = contextSchema.parse(JSON.parse(await hook(ctx, 'session-start', '{}')));
    expect(output.additionalContext).toContain('Concord cannot tell which session you are');
  });

  it('delivers waiting messages after a tool call, once', async () => {
    await hook(ctx, 'session-start');
    sendTo(repos, 'Review the latest diff please.', 'k-1');

    const first = await shownContext(ctx);
    expect(first).toContain('Review the latest diff please.');
    expect(first).toContain('claude:sender');
    expect(JSON.parse(await hook(ctx, 'post-tool-use'))).toEqual({});
  });

  it('never cuts a long message short: it waits for the stop hook, whole', async () => {
    await hook(ctx, 'session-start');
    const long = `${'x'.repeat(12_000)}END`;
    sendTo(repos, long, 'k-big');

    const notice = await shownContext(ctx);
    expect(notice).toContain('too long to show here');
    expect(notice).not.toContain('xxx');

    const stop = stopSchema.parse(JSON.parse(await hook(ctx, 'stop')));
    expect(stop.decision).toBe('block');
    expect(stop.reason).toContain(long);
    expect(JSON.parse(await hook(ctx, 'stop'))).toEqual({});
  });

  it('shows what fits now and the rest, in order, on the next hook', async () => {
    await hook(ctx, 'session-start');
    sendTo(repos, `first ${'a'.repeat(5_000)}`, 'k-a');
    sendTo(repos, `second ${'b'.repeat(5_000)}`, 'k-b');

    const now = await shownContext(ctx);
    expect(now).toContain('first');
    expect(now).not.toContain('second');
    const next = await shownContext(ctx);
    expect(next).toContain('second');
    expect(next?.length).toBeLessThan(10_000);
  });

  it('leaves a hosted session’s newest messages to the live push, so none arrives twice', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    await hook(ctx, 'session-start');
    repos.agentEndpoints.upsert({
      endpointId: 'relay-1',
      agentId: AGENT_ID,
      provider: 'copilot-cli',
      transport: 'local-ipc',
      capabilities: ['local-ipc', 'inject', 'steer', 'idle', 'pull'],
      address: '/tmp/relay.sock',
      credentialHash: 'proof',
      expiresAt: '2026-10-21T00:00:00Z',
    });
    sendTo(repos, 'Pushed live right now.', 'k-live');

    // While the sender's push may still be in flight, hooks take nothing.
    expect(JSON.parse(await hook(ctx, 'post-tool-use'))).toEqual({});
    expect(JSON.parse(await hook(ctx, 'stop'))).toEqual({});

    // A message the push never delivered is drained once it is clearly stale.
    vi.setSystemTime(new Date('2026-10-20T12:00:11Z'));
    expect(await shownContext(ctx)).toContain('Pushed live right now.');
  });

  it('blocks the stop so a late message becomes the next turn', async () => {
    await hook(ctx, 'session-start');
    expect(JSON.parse(await hook(ctx, 'stop'))).toEqual({});

    sendTo(repos, 'Wait, one more thing!', 'k-2');
    const output = stopSchema.parse(JSON.parse(await hook(ctx, 'stop')));
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('Wait, one more thing!');
  });

  it('never fails the session when the backend does', async () => {
    const failing = context({
      register: () => Promise.reject(new Error('down')),
      roster: () => Promise.resolve([]),
      drain: () => Promise.reject(new Error('down')),
      startLiveHost: () => undefined,
    });
    const start = contextSchema.parse(JSON.parse(await hook(failing, 'session-start')));
    expect(start.additionalContext).toContain('down');
    expect(JSON.parse(await hook(failing, 'post-tool-use'))).toEqual({});
    expect(JSON.parse(await hook(failing, 'stop'))).toEqual({});
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
    await hook(context(recording), 'session-start');
    expect(hosts).toEqual([]);

    await hook(context(recording, { serverAddress: '127.0.0.1:47125' }), 'session-start');
    expect(hosts).toEqual([[AGENT_ID, SESSION, '127.0.0.1:47125']]);
  });

  it('reports an unknown event as unhandled', async () => {
    expect(await runCopilotHook(ctx, 'pre-compact', payload())).toBeUndefined();
  });
});

describe('fittingPrefix', () => {
  const message = (id: string, size: number): DeliverableMessage => ({
    messageId: id,
    senderAgentId: 'peer',
    taskId: null,
    content: 'x'.repeat(size),
    messageKind: 'prompt',
    deliveryLatencyMs: null,
  });

  it('keeps arrival order, stopping at the first message that does not fit', () => {
    const fit = fittingPrefix([message('a', 100), message('b', 5_000), message('c', 10)], 1_000);
    expect(fit.map((entry) => entry.messageId)).toEqual(['a']);
  });
});

describe('copilotWorkspace', () => {
  it('reads the payload cwd, falling back to the process cwd', () => {
    expect(copilotWorkspace(payload())).toBe('/repo');
    expect(copilotWorkspace('not json')).toBe(process.cwd());
    expect(copilotWorkspace('{}')).toBe(process.cwd());
  });
});
