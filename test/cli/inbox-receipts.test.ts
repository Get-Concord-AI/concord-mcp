import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { renderStatusText } from '../../src/artifacts/work-state-view.js';
import { observeHookEvent } from '../../src/cli/commands/inbox-observe.js';
import { drainInbox, registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { monitorCapabilityFor } from '../../src/domain/delivery.js';
import { renderedMessageIds, renderMonitorLines } from '../../src/domain/pull-inbox.js';
import { sessionKey, toReceipt } from '../../src/domain/receipts.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleGetWorkState } from '../../src/tools/get-work-state.js';

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

function send(repos: Repositories, content: string, key: string, to = 'beta'): string {
  return handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: 'alpha',
    toAgentId: to,
    content,
    idempotencyKey: key,
  }).message.messageId;
}

const SESSION = 'session-1';

/** What the relay plugin's monitor does: deliver to its session, never read. */
function monitorDrain(repos: Repositories, rawSession = SESSION) {
  return drainInbox(repos, 'beta', 'claude-code', monitorCapabilityFor('claude-code'), {
    session: sessionKey(rawSession),
    via: 'monitor',
  });
}

function hook(event: Record<string, string>, rawSession = SESSION): string {
  return JSON.stringify({ session_id: rawSession, ...event });
}

function events(repos: Repositories, messageId: string): string[] {
  return repos.agentMessages.listEvents(messageId).map((entry) => entry.event);
}

function status(repos: Repositories, messageId: string): string | undefined {
  return repos.agentMessages.get(messageId)?.status;
}

/** A Claude Code transcript as JSONL, written to a temp file. */
function transcript(entries: readonly Record<string, unknown>[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'concord-transcript-')), 'session.jsonl');
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return path;
}

function notificationEntries(line: string): Record<string, unknown>[] {
  return [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: `<task-notification><event>${line}</event>`,
    },
    {
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: `<task-notification>\n<event>${line}</event>` },
    },
  ];
}

describe('messaging v2 receipts', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    registerAgent(repos, 'alpha');
    registerAgent(repos, 'beta');
    registerAgent(repos, 'gamma');
    registerPullEndpoint(repos, 'beta', 'claude-code');
  });

  it('is sent (✓) the moment the store has it, with an expiry', () => {
    const messageId = send(repos, 'hi', 'k1');
    const message = repos.agentMessages.get(messageId);

    expect(message?.status).toBe('sent');
    expect(message?.expiresAt).not.toBeNull();
    expect(toReceipt(message ?? fail()).ticks).toBe('✓');
    expect(events(repos, messageId)).toEqual(['sent']);
  });

  it('queues for a registered agent with no live session instead of failing', () => {
    const result = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'gamma',
      content: 'when you are back',
      idempotencyKey: 'k1',
    });

    expect(result.message.status).toBe('sent');
    expect(result.delivery).toBe('queued_pull');
    expect(result.outlook).toMatch(/no live session/);
  });

  it('marks a monitor drain delivered (✓✓) to that session, never read', () => {
    const messageId = send(repos, 'ping', 'k1');
    monitorDrain(repos);
    const message = repos.agentMessages.get(messageId);

    expect(message?.status).toBe('delivered');
    expect(message?.deliveredVia).toBe('monitor');
    expect(message?.deliveredSession).toBe(sessionKey(SESSION));
    expect(message?.readAt).toBeNull();
  });

  it('keeps a message delivered while the agent waits on an AskUserQuestion, read once it answers (#208)', () => {
    const messageId = send(repos, 'while you were asking', 'k1');
    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }),
    );
    const [line] = renderMonitorLines(monitorDrain(repos));
    // Claude Code holds the notification: the transcript only has it queued.
    const held = transcript([
      { type: 'assistant', message: { role: 'assistant', content: 'asking the user' } },
      notificationEntries(line ?? '')[0] ?? {},
    ]);
    observeHookEvent(repos, 'beta', hook({ hook_event_name: 'Stop', transcript_path: held }));
    expect(status(repos, messageId)).toBe('delivered');

    // The user answers; the held notification starts a turn.
    const prompt = `<task-notification><event>${line ?? ''}</event></task-notification>`;
    const observed = observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'UserPromptSubmit', prompt }),
    );

    expect(observed.read).toEqual([messageId]);
    expect(status(repos, messageId)).toBe('read');
    expect(repos.agentMessages.listEvents(messageId).at(-1)).toMatchObject({
      event: 'read',
      detail: 'prompt',
    });
  });

  it('reads from the transcript only when the model wrote something after the message', () => {
    const messageId = send(repos, 'mid-turn', 'k1');
    const [line] = renderMonitorLines(monitorDrain(repos));
    const shownOnly = transcript(notificationEntries(line ?? ''));
    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'PostToolUse', transcript_path: shownOnly }),
    );
    expect(status(repos, messageId)).toBe('delivered');

    const answered = transcript([
      ...notificationEntries(line ?? ''),
      { type: 'assistant', message: { role: 'assistant', content: 'on it' } },
    ]);
    observeHookEvent(repos, 'beta', hook({ hook_event_name: 'Stop', transcript_path: answered }));

    expect(status(repos, messageId)).toBe('read');
    expect(repos.agentMessages.listEvents(messageId).at(-1)?.detail).toBe('transcript');
  });

  it('reads a hook-delivered message from the transcript at the next hook', () => {
    const messageId = send(repos, 'hook body', 'k1');
    drainInbox(repos, 'beta', 'claude-code', undefined, {
      session: sessionKey(SESSION),
      via: 'hook',
    });
    expect(status(repos, messageId)).toBe('delivered');
    const path = transcript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          content: `[concord from alpha id=${messageId}]\nhook body`,
        },
      },
      { type: 'assistant', message: { role: 'assistant', content: 'noted' } },
    ]);

    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'PostToolUse', transcript_path: path }),
    );
    expect(status(repos, messageId)).toBe('read');
  });

  it('never credits a read to a session the message was not delivered to', () => {
    const messageId = send(repos, 'ping', 'k1');
    const [line] = renderMonitorLines(monitorDrain(repos, 'session-A'));

    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'UserPromptSubmit', prompt: line ?? '' }, 'session-B'),
    );
    expect(status(repos, messageId)).toBe('delivered');
  });

  it('ignores ids in a prompt that were not delivered to this agent', () => {
    registerPullEndpoint(repos, 'gamma', 'claude-code');
    const toGamma = send(repos, 'not yours', 'k1', 'gamma');
    drainInbox(repos, 'gamma', 'claude-code', undefined, { session: sessionKey(SESSION) });

    const observed = observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'UserPromptSubmit', prompt: `[concord from alpha id=${toGamma}] x` }),
    );
    expect(observed.read).toEqual([]);
    expect(status(repos, toGamma)).toBe('delivered');
  });

  it('ignores hooks fired inside a subagent (#216)', () => {
    const messageId = send(repos, 'for the main agent', 'k1');
    const [line] = renderMonitorLines(monitorDrain(repos));

    observeHookEvent(
      repos,
      'beta',
      JSON.stringify({
        session_id: SESSION,
        agent_id: 'sub-1',
        hook_event_name: 'UserPromptSubmit',
        prompt: line,
      }),
    );
    expect(status(repos, messageId)).toBe('delivered');
  });

  it("requeues what an earlier session never read, for this agent's fresh session", () => {
    const messageId = send(repos, 'held by a killed session', 'k1');
    monitorDrain(repos, 'old-session');

    const observed = observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'SessionStart', source: 'startup' }, 'new-session'),
    );

    expect(observed.requeued).toEqual([messageId]);
    expect(status(repos, messageId)).toBe('sent');
    expect(monitorDrain(repos, 'new-session').map((message) => message.messageId)).toEqual([
      messageId,
    ]);
    expect(events(repos, messageId)).toEqual(['sent', 'delivered', 'requeued', 'delivered']);
  });

  it('does not requeue on resume, or what the same session holds, or what was read', () => {
    const held = send(repos, 'held', 'k1');
    monitorDrain(repos);
    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'SessionStart', source: 'resume' }, 'other'),
    );
    observeHookEvent(repos, 'beta', hook({ hook_event_name: 'SessionStart', source: 'startup' }));
    expect(status(repos, held)).toBe('delivered');

    const [line] = renderMonitorLines(monitorDrain(repos));
    expect(line).toBeUndefined();
    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'UserPromptSubmit', prompt: `[concord from alpha id=${held}] held` }),
    );
    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'SessionStart', source: 'startup' }, 'later'),
    );
    expect(status(repos, held)).toBe('read');
  });

  it('treats a reply as read and replied', () => {
    const messageId = send(repos, 'question?', 'k1');
    monitorDrain(repos);
    handleSendAgentMessage(repos, {
      operation: 'reply',
      agentId: 'beta',
      replyToMessageId: messageId,
      content: 'answer',
      idempotencyKey: 'r1',
    });
    const message = repos.agentMessages.get(messageId);

    expect(message?.status).toBe('replied');
    expect(message?.readAt).not.toBeNull();
  });

  it('expires a message nobody took', () => {
    const messageId = send(repos, 'too late', 'k1', 'gamma');
    repos.db
      .prepare('UPDATE agent_messages SET expires_at = ? WHERE message_id = ?')
      .run('2000-01-01T00:00:00.000Z', messageId);

    expect(repos.agentMessages.expireStale().map((message) => message.messageId)).toEqual([
      messageId,
    ]);
    const message = repos.agentMessages.get(messageId);
    expect(message?.status).toBe('failed');
    expect(message?.errorCode).toBe('expired');
  });

  it('tells a retrying sender where the message actually got to', () => {
    const first = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'beta',
      content: 'once',
      idempotencyKey: 'k1',
    });
    monitorDrain(repos);
    const retry = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'beta',
      content: 'once',
      idempotencyKey: 'k1',
    });

    expect(retry.idempotentReplay).toBe(true);
    expect(retry.message.messageId).toBe(first.message.messageId);
    expect(retry.outlook).toMatch(/not read it yet/);
  });

  it('ignores a payload it cannot read', () => {
    expect(observeHookEvent(repos, 'beta', 'not json')).toEqual({ read: [], requeued: [] });
  });
});

describe('renderedMessageIds', () => {
  it('reads ids back from monitor lines and hook bodies alike', () => {
    expect(
      renderedMessageIds('[concord from a id=m1] x\n[concord from b id=m2 task=t]\ny'),
    ).toEqual(['m1', 'm2']);
  });

  it('finds nothing in an ordinary prompt', () => {
    expect(renderedMessageIds('please fix the build')).toEqual([]);
  });
});

describe('waiting on the user', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    registerAgent(repos, 'alpha');
    registerAgent(repos, 'beta');
    registerPullEndpoint(repos, 'beta', 'claude-code');
  });

  function awaitingSince(): string | null | undefined {
    return repos.agentEndpoints.getByAgent('beta')?.awaitingUserSince;
  }

  function ask(): void {
    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }),
    );
  }

  it('tells the sender when the recipient stopped for a question, but still delivers', () => {
    ask();
    expect(awaitingSince()).not.toBeNull();

    const result = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'beta',
      content: 'ping',
      idempotencyKey: 'k1',
    });

    expect(result.outlook).toMatch(/wait on its user/i);
    expect(monitorDrain(repos)).toHaveLength(1);
  });

  it('records a permission prompt, and nothing for other tools or notifications', () => {
    observeHookEvent(repos, 'beta', hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }));
    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }),
    );
    expect(awaitingSince()).toBeNull();

    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
    );
    expect(awaitingSince()).not.toBeNull();
  });

  it('ignores a question asked by a background agent forked from the session', () => {
    observeHookEvent(
      repos,
      'beta',
      hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        agent_id: 'background-agent-1',
      }),
    );

    expect(awaitingSince()).toBeNull();
  });

  it('keeps the start of an ongoing wait', () => {
    ask();
    const first = awaitingSince();
    observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
    );

    expect(awaitingSince()).toBe(first);
  });

  it.each([
    ['a tool finishing', { hook_event_name: 'PostToolUse' }],
    ['the turn ending', { hook_event_name: 'Stop' }],
    ['a new prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }],
    ['a resumed session', { hook_event_name: 'SessionStart', source: 'resume' }],
  ])('clears on %s', (_label, event) => {
    ask();
    observeHookEvent(repos, 'beta', hook(event));

    expect(awaitingSince()).toBeNull();
  });

  it('shows the wait in workspace status', () => {
    ask();

    expect(renderStatusText(handleGetWorkState(repos))).toMatch(
      /beta\s+promptable via claude-code, waiting on its user since /,
    );
  });
});

function fail(): never {
  throw new Error('missing message');
}
