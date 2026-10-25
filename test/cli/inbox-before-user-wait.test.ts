import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { observeHookEvent } from '../../src/cli/commands/inbox-observe.js';
import {
  drainBeforeUserWait,
  drainInbox,
  registerPullEndpoint,
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

const SESSION = 'session-1';

/** What the relay plugin's monitor does: deliver to its session, never read. */
function monitorDrain(repos: Repositories, rawSession = SESSION): DeliverableMessage[] {
  return drainInbox(repos, 'beta', 'claude-code', monitorCapabilityFor('claude-code'), {
    session: sessionKey(rawSession),
    via: 'monitor',
  });
}

function beforeWait(repos: Repositories, rawSession = SESSION) {
  return drainBeforeUserWait(repos, 'beta', 'claude-code', sessionKey(rawSession));
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
    repos = createRepositories(openDatabase(':memory:'));
    registerAgent(repos, 'alpha');
    registerAgent(repos, 'beta');
    registerPullEndpoint(repos, 'beta', 'claude-code');
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
