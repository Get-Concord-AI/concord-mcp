import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { renderStatusText } from '../../src/artifacts/work-state-view.js';
import {
  observeHookEvent,
  observeToolDone,
  observeTurnEnd,
} from '../../src/cli/commands/inbox-observe.js';
import { drainInbox, registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { monitorCapabilityFor } from '../../src/domain/delivery.js';
import { renderedMessageIds, renderMonitorLines } from '../../src/domain/pull-inbox.js';
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

function send(repos: Repositories, content: string, key: string): string {
  return handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: 'alpha',
    toAgentId: 'beta',
    content,
    idempotencyKey: key,
  }).message.messageId;
}

/** What the relay plugin's monitor does: drain, leaving seeing to the session. */
function monitorDrain(repos: Repositories) {
  return drainInbox(repos, 'beta', 'claude-code', monitorCapabilityFor('claude-code'), {
    awaitSeen: true,
  });
}

function hook(event: Record<string, string>): string {
  return JSON.stringify({ session_id: 'session-1', ...event });
}

function events(repos: Repositories, messageId: string): string[] {
  return repos.agentMessages.listEvents(messageId).map((entry) => entry.event);
}

describe('seen versus delivered', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    registerAgent(repos, 'alpha');
    registerAgent(repos, 'beta');
    registerPullEndpoint(repos, 'beta', 'claude-code');
  });

  it('counts a hook drain as seen, since the hook puts it straight into the turn', () => {
    const messageId = send(repos, 'mid-turn', 'k1');
    drainInbox(repos, 'beta', 'claude-code');

    const message = repos.agentMessages.get(messageId);
    expect(message?.seenAt).toBe(message?.deliveredAt);
    expect(events(repos, messageId)).toEqual(['accepted', 'delivered']);
  });

  it('leaves a monitor drain unseen: the harness may hold it while the agent waits on its user', () => {
    const messageId = send(repos, 'while you were asking', 'k1');
    monitorDrain(repos);

    const message = repos.agentMessages.get(messageId);
    expect(message?.status).toBe('delivered');
    expect(message?.seenAt).toBeNull();
  });

  it('marks it seen when the notification starts a turn', () => {
    const messageId = send(repos, 'ping', 'k1');
    const [line] = renderMonitorLines(monitorDrain(repos));
    const prompt = `<task-notification><event>${line ?? ''}</event></task-notification>`;

    const observed = observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'UserPromptSubmit', prompt }),
    );

    expect(observed.seen).toEqual([messageId]);
    expect(repos.agentMessages.get(messageId)?.seenAt).not.toBeNull();
    expect(repos.agentMessages.listEvents(messageId).at(-1)).toMatchObject({
      event: 'seen',
      detail: 'prompt',
    });
  });

  it('ignores ids in a prompt that were not delivered to this agent', () => {
    registerPullEndpoint(repos, 'alpha', 'claude-code');
    const toAlpha = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'beta',
      toAgentId: 'alpha',
      content: 'not yours',
      idempotencyKey: 'k1',
    }).message.messageId;
    drainInbox(repos, 'alpha', 'claude-code', monitorCapabilityFor('claude-code'), {
      awaitSeen: true,
    });

    const observed = observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'UserPromptSubmit', prompt: `[concord from beta id=${toAlpha}] x` }),
    );

    expect(observed.seen).toEqual([]);
    expect(repos.agentMessages.get(toAlpha)?.seenAt).toBeNull();
  });

  it('marks it seen when the turn that was blocked on the user ends', () => {
    const messageId = send(repos, 'held behind a question', 'k1');
    monitorDrain(repos);

    expect(observeTurnEnd(repos, 'beta')).toEqual([messageId]);
    expect(repos.agentMessages.listEvents(messageId).at(-1)).toMatchObject({
      event: 'seen',
      detail: 'stop',
    });
  });

  it('does not count a message delivered after the turn ended', () => {
    const messageId = send(repos, 'too late for that turn', 'k1');
    monitorDrain(repos);

    expect(observeTurnEnd(repos, 'beta', new Date(Date.now() - 60_000))).toEqual([]);
    expect(repos.agentMessages.get(messageId)?.seenAt).toBeNull();
  });

  it('requeues what a killed session never showed, for the next session of that agent', () => {
    const messageId = send(repos, 'are you there?', 'k1');
    monitorDrain(repos);

    const observed = observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'SessionStart', source: 'startup' }),
    );

    expect(observed.requeued).toEqual([messageId]);
    const requeued = repos.agentMessages.get(messageId);
    expect(requeued?.status).toBe('pending');
    expect(requeued?.deliveredAt).toBeNull();
    expect(monitorDrain(repos).map((message) => message.messageId)).toEqual([messageId]);
    expect(events(repos, messageId)).toEqual(['accepted', 'delivered', 'requeued', 'delivered']);
  });

  it('does not requeue on resume, which restores the notification the session was holding', () => {
    const messageId = send(repos, 'are you there?', 'k1');
    monitorDrain(repos);

    const observed = observeHookEvent(
      repos,
      'beta',
      hook({ hook_event_name: 'SessionStart', source: 'resume' }),
    );

    expect(observed.requeued).toEqual([]);
    expect(repos.agentMessages.get(messageId)?.status).toBe('delivered');
  });

  it('never requeues a message the agent saw', () => {
    const messageId = send(repos, 'seen already', 'k1');
    monitorDrain(repos);
    observeTurnEnd(repos, 'beta');

    observeHookEvent(repos, 'beta', hook({ hook_event_name: 'SessionStart', source: 'startup' }));

    expect(repos.agentMessages.get(messageId)?.status).toBe('delivered');
  });

  it('treats a reply as proof the agent saw the message', () => {
    registerPullEndpoint(repos, 'alpha', 'claude-code');
    const messageId = send(repos, 'reply if you see this', 'k1');
    monitorDrain(repos);
    handleSendAgentMessage(repos, {
      operation: 'reply',
      agentId: 'beta',
      replyToMessageId: messageId,
      content: 'seen it',
      idempotencyKey: 'k2',
    });

    const message = repos.agentMessages.get(messageId);
    expect(message?.status).toBe('replied');
    expect(message?.seenAt).not.toBeNull();
  });

  it('tells a retrying sender where the message actually got to', () => {
    const retry = () =>
      handleSendAgentMessage(repos, {
        operation: 'prompt',
        agentId: 'alpha',
        toAgentId: 'beta',
        content: 'ping',
        idempotencyKey: 'k1',
      });
    retry();
    monitorDrain(repos);
    expect(retry().outlook).toMatch(/has not seen it yet/i);

    observeTurnEnd(repos, 'beta');
    expect(retry().outlook).toMatch(/has seen it/i);
  });

  it('ignores a payload it cannot read', () => {
    expect(observeHookEvent(repos, 'beta', 'not json')).toEqual({ seen: [], requeued: [] });
    expect(observeHookEvent(repos, 'beta', '{}')).toEqual({ seen: [], requeued: [] });
  });
});

describe('renderedMessageIds', () => {
  it('reads ids back from monitor lines and hook bodies alike', () => {
    const text =
      '[concord from alpha id=m-1] hello\n' +
      '[concord from alpha id=m-2 task=TASK-9]\nbody\n' +
      '[concord from alpha id=m-1] repeated';

    expect(renderedMessageIds(text)).toEqual(['m-1', 'm-2']);
  });

  it('finds nothing in an ordinary prompt', () => {
    expect(renderedMessageIds('please fix the concord bug')).toEqual([]);
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
    [
      'a tool finishing',
      () => {
        observeToolDone(repos, 'beta');
      },
    ],
    ['the turn ending', () => observeTurnEnd(repos, 'beta')],
    [
      'a new prompt',
      () =>
        observeHookEvent(
          repos,
          'beta',
          hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
        ),
    ],
    [
      'a resumed session',
      () =>
        observeHookEvent(
          repos,
          'beta',
          hook({ hook_event_name: 'SessionStart', source: 'resume' }),
        ),
    ],
  ])('clears on %s', (_label, moveOn) => {
    ask();
    moveOn();

    expect(awaitingSince()).toBeNull();
  });

  it('shows the wait in workspace status', () => {
    ask();

    expect(renderStatusText(handleGetWorkState(repos))).toMatch(
      /beta\s+promptable via claude-code, waiting on its user since /,
    );
  });
});
