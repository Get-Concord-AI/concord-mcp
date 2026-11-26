import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { observeHookEvent } from '../../src/cli/commands/inbox-observe.js';
import {
  drainBeforeUserWait,
  drainInbox,
  registerPullEndpoint,
  USER_WAIT_DENY_WINDOW_MS,
} from '../../src/cli/commands/inbox.js';
import { monitorCapabilityFor } from '../../src/domain/delivery.js';
import {
  renderHookPayload,
  renderMonitorLines,
  type DeliverableMessage,
} from '../../src/domain/pull-inbox.js';
import { sessionKey } from '../../src/domain/receipts.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';

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
}

function send(repos: Repositories, content: string, key: string): string {
  return handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: 'alpha',
    toAgentId: 'beta',
    content,
    idempotencyKey: key,
  }).message.messageId;
}

/** A store where alpha can message beta, which has a pull endpoint. */
function freshRepos(): Repositories {
  const repos = createRepositories(openDatabase(':memory:'));
  registerAgent(repos, 'alpha');
  registerAgent(repos, 'beta');
  registerPullEndpoint(repos, 'beta', 'claude-code');
  return repos;
}

const SESSION = 'session-1';

/** What the relay plugin's monitor does: deliver to its session, never read. */
function monitorDrain(repos: Repositories, rawSession = SESSION): DeliverableMessage[] {
  return drainInbox(repos, 'beta', 'claude-code', monitorCapabilityFor('claude-code'), {
    session: sessionKey(rawSession),
    via: 'monitor',
  });
}

function beforeWait(repos: Repositories, rawSession = SESSION, now = new Date()) {
  return drainBeforeUserWait(repos, 'beta', 'claude-code', sessionKey(rawSession), now);
}

function ids(result: { held: DeliverableMessage[]; claimed: DeliverableMessage[] }): string[] {
  return [...result.held, ...result.claimed].map((entry) => entry.messageId);
}

function hook(event: Record<string, string>): string {
  return JSON.stringify({ session_id: SESSION, ...event });
}

const ASK = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' };

function awaitingSince(repos: Repositories): string | null | undefined {
  return repos.agentEndpoints.getByAgent('beta')?.awaitingUserSince;
}

const MESSAGE: DeliverableMessage = {
  messageId: 'm1',
  senderAgentId: 'alpha',
  taskId: null,
  content: 'ping',
  messageKind: 'prompt',
  deliveryLatencyMs: 10,
  expectsReply: true,
};

const preToolUseSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('PreToolUse'),
    permissionDecision: z.literal('deny'),
    permissionDecisionReason: z.string(),
  }),
});

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A Claude Code transcript as JSONL, written to a temp file. */
function transcript(entries: readonly Record<string, Json>[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'concord-transcript-')), 'session.jsonl');
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return path;
}

describe('hook output just before the session blocks on its user', () => {
  it('denies the question with the messages as the reason, so the model reads them first', () => {
    const payload = preToolUseSchema.parse(
      JSON.parse(renderHookPayload('pre-tool-use', [MESSAGE])),
    );

    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain(
      '[concord from alpha id=m1]',
    );
    expect(payload.hookSpecificOutput.permissionDecisionReason).toMatch(/ask your question again/);
  });

  it('never allows with updatedInput, which would answer the question without showing it', () => {
    const output = renderHookPayload('pre-tool-use', [MESSAGE]);

    expect(output).not.toContain('updatedInput');
    expect(output).not.toContain('"allow"');
  });
});

describe('drainBeforeUserWait', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = freshRepos();
  });

  it('claims a queued message for this session as hook-delivered, not read', () => {
    const messageId = send(repos, 'before you ask', 'k1');

    const { held, claimed } = beforeWait(repos);
    const message = repos.agentMessages.get(messageId);

    expect(held).toEqual([]);
    expect(claimed.map((entry) => entry.messageId)).toEqual([messageId]);
    expect(message?.status).toBe('delivered');
    expect(message?.deliveredVia).toBe('hook');
    expect(message?.deliveredSession).toBe(sessionKey(SESSION));
    expect(message?.readAt).toBeNull();
  });

  it('includes a message the monitor took whose notification is still held', () => {
    const messageId = send(repos, 'held by the harness', 'k1');
    monitorDrain(repos);

    const { held, claimed } = beforeWait(repos);

    expect(held.map((entry) => entry.messageId)).toEqual([messageId]);
    expect(claimed).toEqual([]);
    // Showing it again is not proof it was read; that still takes evidence.
    expect(repos.agentMessages.get(messageId)?.status).toBe('delivered');
  });

  it('leaves out a message the session has already shown its model', () => {
    send(repos, 'already seen', 'k1');
    const [line] = renderMonitorLines(monitorDrain(repos));
    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'UserPromptSubmit', prompt: `<event>${line ?? ''}</event>` }),
    );

    expect(beforeWait(repos)).toEqual({ held: [], claimed: [] });
  });

  it('leaves out a message another session of the agent was handed', () => {
    send(repos, 'for the other session', 'k1');
    monitorDrain(repos, 'session-2');

    expect(beforeWait(repos)).toEqual({ held: [], claimed: [] });
  });

  it('keeps the agent marked as waiting on its user when there is nothing to show', () => {
    observeHookEvent(repos, 'beta', hook(ASK));

    expect(beforeWait(repos)).toEqual({ held: [], claimed: [] });
    expect(awaitingSince(repos)).not.toBeNull();
  });

  it('clears the waiting flag when it delivers, since the user is not asked yet', () => {
    send(repos, 'read me first', 'k1');
    observeHookEvent(repos, 'beta', hook(ASK));

    beforeWait(repos);

    expect(awaitingSince(repos)).toBeNull();
  });

  it('marks a message read once the model responds to the deny that carried it', () => {
    const messageId = send(repos, 'carried by the deny', 'k1');
    const { claimed } = beforeWait(repos);
    const reason = preToolUseSchema.parse(JSON.parse(renderHookPayload('pre-tool-use', claimed)))
      .hookSpecificOutput.permissionDecisionReason;
    const path = transcript([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: reason },
          ],
        },
      },
      { type: 'assistant', message: { role: 'assistant', content: 'read it, asking again' } },
    ]);

    observeHookEvent(repos, 'beta', hook({ ...ASK, transcript_path: path }));

    expect(repos.agentMessages.get(messageId)?.status).toBe('read');
  });
});

describe('at most one deny per question', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = freshRepos();
  });

  it('lets the question asked right after a deny open the picker', () => {
    send(repos, 'read me first', 'k1');
    const asked = new Date('2026-11-22T10:00:00.000Z');

    expect(ids(beforeWait(repos, SESSION, asked))).toHaveLength(1);
    // The transcript has not caught up, so the message still has no read
    // evidence; it must not deny the same question again.
    expect(beforeWait(repos, SESSION, new Date(asked.getTime() + 5_000))).toEqual({
      held: [],
      claimed: [],
    });
  });

  it('lets the question through even when a peer keeps sending', () => {
    const asked = new Date('2026-11-22T10:00:00.000Z');
    send(repos, 'first', 'k1');
    expect(ids(beforeWait(repos, SESSION, asked))).toHaveLength(1);

    const fresh = send(repos, 'and another', 'k2');
    expect(beforeWait(repos, SESSION, new Date(asked.getTime() + 5_000))).toEqual({
      held: [],
      claimed: [],
    });
    // Still waiting (sent) for the monitor or the next tool result, not lost.
    expect(repos.agentMessages.get(fresh)?.status).toBe('sent');
  });

  it('drains again on the question after the one it let through', () => {
    const asked = new Date('2026-11-22T10:00:00.000Z');
    send(repos, 'first', 'k1');
    beforeWait(repos, SESSION, asked);
    beforeWait(repos, SESSION, new Date(asked.getTime() + 5_000));

    const later = send(repos, 'a new question, a new chance', 'k2');
    expect(ids(beforeWait(repos, SESSION, new Date(asked.getTime() + 10_000)))).toContain(later);
  });

  it('drains as usual once the deny is older than the window', () => {
    const asked = new Date('2026-11-22T10:00:00.000Z');
    send(repos, 'first', 'k1');
    beforeWait(repos, SESSION, asked);

    const later = send(repos, 'much later', 'k2');
    const after = new Date(asked.getTime() + USER_WAIT_DENY_WINDOW_MS + 1);
    expect(ids(beforeWait(repos, SESSION, after))).toContain(later);
  });

  it('records no deny when there was nothing to show', () => {
    beforeWait(repos);

    expect(repos.agentEndpoints.takeUserWaitAllowance('beta', sessionKey(SESSION))).toBeUndefined();
  });
});

describe('the allowance belongs to the session that was denied', () => {
  let repos: Repositories;
  const asked = new Date('2026-11-22T10:00:00.000Z');
  const soon = new Date(asked.getTime() + 5_000);

  beforeEach(() => {
    repos = freshRepos();
  });

  it("does not let another session's question skip the drain", () => {
    send(repos, 'first', 'k1');
    expect(ids(beforeWait(repos, SESSION, asked))).toHaveLength(1);

    const fresh = send(repos, 'for whoever asks next', 'k2');
    // Another session of the same agent, or a fresh one after a restart.
    expect(ids(beforeWait(repos, 'session-2', soon))).toEqual([fresh]);
  });

  it("keeps the denied session's allowance when another session asks first", () => {
    send(repos, 'first', 'k1');
    beforeWait(repos, SESSION, asked);

    // Session 2 has nothing to show, so it neither denies nor spends anything.
    expect(beforeWait(repos, 'session-2', soon)).toEqual({ held: [], claimed: [] });

    send(repos, 'and another', 'k2');
    expect(beforeWait(repos, SESSION, soon)).toEqual({ held: [], claimed: [] });
  });

  it('records the allowance for the session that was denied, and only that one', () => {
    send(repos, 'first', 'k1');
    beforeWait(repos, SESSION, asked);

    expect(repos.agentEndpoints.takeUserWaitAllowance('beta', sessionKey('session-2'))).toBe(
      undefined,
    );
    expect(repos.agentEndpoints.takeUserWaitAllowance('beta', sessionKey(SESSION))).toBe(
      asked.toISOString(),
    );
  });

  it("never lets one session's deny replace another's allowance", () => {
    send(repos, 'for session 1', 'k1');
    expect(ids(beforeWait(repos, SESSION, asked))).toHaveLength(1);
    send(repos, 'for session 2', 'k2');
    expect(ids(beforeWait(repos, 'session-2', asked))).toHaveLength(1);

    // Another message arrives before session 1 asks again: its question is
    // still let through, not denied a second time.
    send(repos, 'and another', 'k3');
    expect(beforeWait(repos, SESSION, soon)).toEqual({ held: [], claimed: [] });
    expect(beforeWait(repos, 'session-2', soon)).toEqual({ held: [], claimed: [] });
  });

  it('keeps one allowance for a session the hook cannot name', () => {
    send(repos, 'first', 'k1');
    drainBeforeUserWait(repos, 'beta', 'claude-code', null, asked);

    send(repos, 'and another', 'k2');
    expect(drainBeforeUserWait(repos, 'beta', 'claude-code', null, soon)).toEqual({
      held: [],
      claimed: [],
    });
  });

  it('drops allowances no question spent in time when a new one is granted', () => {
    send(repos, 'first', 'k1');
    beforeWait(repos, SESSION, asked);

    // Session 1 never asks again. Much later, session 2 is denied.
    const later = new Date(asked.getTime() + USER_WAIT_DENY_WINDOW_MS + 1);
    send(repos, 'much later', 'k2');
    beforeWait(repos, 'session-2', later);

    expect(repos.agentEndpoints.takeUserWaitAllowance('beta', sessionKey(SESSION))).toBe(undefined);
  });
});

describe('a monitor drain racing the hook', () => {
  it('cannot take a message between listing held messages and claiming queued ones', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'concord-race-')), 'concord.db');
    const hook = createRepositories(openDatabase(path));
    const monitor = createRepositories(openDatabase(path));
    // Fail at once instead of waiting out the lock the hook holds.
    monitor.db.pragma('busy_timeout = 0');
    registerAgent(hook, 'alpha');
    registerAgent(hook, 'beta');
    registerPullEndpoint(hook, 'beta', 'claude-code');
    const messageId = send(hook, 'in the gap', 'k1');

    // The monitor, in another process, polls right after the hook has listed
    // what this session holds and before it claims what is queued.
    let monitorTook: DeliverableMessage[] | undefined;
    const listUnread = hook.agentMessages.listUnreadForSession.bind(hook.agentMessages);
    vi.spyOn(hook.agentMessages, 'listUnreadForSession').mockImplementation((agent, session) => {
      const held = listUnread(agent, session);
      try {
        monitorTook = monitorDrain(monitor);
      } catch {
        monitorTook = [];
      }
      return held;
    });

    const result = drainBeforeUserWait(hook, 'beta', 'claude-code', sessionKey(SESSION));

    expect(monitorTook).toEqual([]);
    expect(ids(result)).toEqual([messageId]);
  });
});
