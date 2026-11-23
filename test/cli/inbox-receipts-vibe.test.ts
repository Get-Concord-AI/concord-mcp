import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { observeHookEvent } from '../../src/cli/commands/inbox-observe.js';
import { drainInbox, registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { renderMonitorLines } from '../../src/domain/pull-inbox.js';
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

function send(repos: Repositories, content: string, key: string, to = 'beta'): string {
  return handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: 'alpha',
    toAgentId: to,
    content,
    idempotencyKey: key,
  }).message.messageId;
}

function status(repos: Repositories, messageId: string): string | undefined {
  return repos.agentMessages.get(messageId)?.status;
}

const SESSION = 'session-1';

describe('Vibe hook payloads', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    registerAgent(repos, 'alpha');
    registerAgent(repos, 'beta');
    registerPullEndpoint(repos, 'beta', 'vibe');
  });

  function vibeHook(event: Record<string, string>): string {
    return JSON.stringify({
      session_id: SESSION,
      parent_session_id: null,
      cwd: '/repo',
      ...event,
    });
  }

  it('ignores hooks fired inside a spawned subagent (parent_session_id)', () => {
    const messageId = send(repos, 'for the main agent', 'k1');
    const delivered = drainInbox(repos, 'beta', 'vibe', undefined, {
      session: sessionKey(SESSION),
      via: 'hook',
    });
    const [line] = renderMonitorLines(delivered);

    observeHookEvent(
      repos,
      'beta',
      vibeHook({
        hook_event_name: 'pre_agent',
        parent_session_id: 'parent-session-1',
        prompt: line ?? '',
      }),
    );
    expect(status(repos, messageId)).toBe('delivered');

    // The session's own hook with the same evidence does count.
    observeHookEvent(repos, 'beta', vibeHook({ hook_event_name: 'pre_agent', prompt: line ?? '' }));
    expect(status(repos, messageId)).toBe('read');
  });

  it("reads read-evidence from Vibe's history chunks under transcript_path", () => {
    const messageId = send(repos, 'chunk note', 'k1');
    drainInbox(repos, 'beta', 'vibe', undefined, {
      session: sessionKey(SESSION),
      via: 'hook',
    });
    // Vibe's transcript_path is the session directory; the conversation lives
    // in hash-named chunks/*.json snapshots as {message: {role, content}}.
    const dir = mkdtempSync(join(tmpdir(), 'concord-vibe-session-'));
    const chunks = join(dir, 'chunks');
    mkdirSync(chunks, { recursive: true });
    writeFileSync(
      join(chunks, 'aaa.json'),
      JSON.stringify([
        {
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              {
                type: 'text',
                text: `[concord from alpha id=${messageId}]\nchunk note`,
              },
            ],
          },
          source: 'history',
          turn_index: 0,
        },
        {
          message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
          source: 'history',
          turn_index: 0,
        },
      ]),
    );

    observeHookEvent(
      repos,
      'beta',
      vibeHook({ hook_event_name: 'post_tool', transcript_path: dir }),
    );
    expect(status(repos, messageId)).toBe('read');
  });

  it('skips history chunks larger than the read budget instead of loading them', () => {
    const messageId = send(repos, 'huge note', 'k1');
    drainInbox(repos, 'beta', 'vibe', undefined, {
      session: sessionKey(SESSION),
      via: 'hook',
    });
    const dir = mkdtempSync(join(tmpdir(), 'concord-vibe-big-'));
    const chunks = join(dir, 'chunks');
    mkdirSync(chunks, { recursive: true });
    // The snapshot holds read evidence but exceeds the 4 MiB tail budget, so
    // the hook must skip it rather than load an arbitrarily large history.
    writeFileSync(
      join(chunks, 'big.json'),
      JSON.stringify([
        {
          message: {
            role: 'user',
            content: `[concord from alpha id=${messageId}]\nhuge note`,
          },
        },
        { message: { role: 'assistant', content: 'ok' } },
        { message: { role: 'user', content: 'x'.repeat(5 * 1024 * 1024) } },
      ]),
    );

    observeHookEvent(
      repos,
      'beta',
      vibeHook({ hook_event_name: 'post_tool', transcript_path: dir }),
    );
    expect(status(repos, messageId)).toBe('delivered');
  });

  it('marks the session waiting on its user for approval and question notifications', () => {
    const awaitingSince = (): string | null | undefined =>
      repos.agentEndpoints.getByAgent('beta')?.awaitingUserSince;

    observeHookEvent(
      repos,
      'beta',
      vibeHook({ hook_event_name: 'notification', notification_type: 'turn_completed' }),
    );
    expect(awaitingSince()).toBeNull();

    observeHookEvent(
      repos,
      'beta',
      vibeHook({ hook_event_name: 'notification', notification_type: 'approval_requested' }),
    );
    expect(awaitingSince()).not.toBeNull();
  });
});
