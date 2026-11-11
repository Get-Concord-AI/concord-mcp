import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  claimWaiter,
  hostsRewake,
  renderRewake,
  REWAKE_HEADER,
  standDownWhenSuperseded,
} from '../../src/cli/commands/inbox-rewake.js';
import { codexThreadHostable, embeddingHost } from '../../src/cli/embedding-host.js';
import { observeHookEvent } from '../../src/cli/commands/inbox-observe.js';
import { registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import type { DeliverableMessage } from '../../src/domain/pull-inbox.js';

function message(messageId: string, content: string): DeliverableMessage {
  return {
    messageId,
    senderAgentId: 'codex:1234abcd',
    content,
    taskId: null,
    messageKind: 'prompt',
    deliveryLatencyMs: 0,
  };
}

describe('asyncRewake waiter for SDK-hosted Claude Code', () => {
  it('runs only where plugin monitors never start', () => {
    expect(hostsRewake({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })).toBe(true);
    expect(hostsRewake({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' })).toBe(true);
    // Interactive sessions have the native monitor; a second receiver would race it.
    expect(hostsRewake({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(false);
    // -p runs are one-shot and their async hooks are killed at teardown.
    expect(hostsRewake({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })).toBe(false);
    expect(hostsRewake({})).toBe(false);
  });

  it('frames each message the way the monitor does, so the agent knows who and which id', () => {
    const text = renderRewake([message('m-1', 'take\nschema.ts'), message('m-2', 'ok')]);

    expect(text).toBe(
      `${REWAKE_HEADER}\n` +
        '[concord from codex:1234abcd id=m-1] take schema.ts\n' +
        '[concord from codex:1234abcd id=m-2] ok\n',
    );
  });

  it('lets the newest waiter for an agent stand the older ones down', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const first = claimWaiter('claude-code:4f2a91c7', 'token-1', dir);
    expect(first.superseded()).toBe(false);

    const second = claimWaiter('claude-code:4f2a91c7', 'token-2', dir);
    expect(first.superseded()).toBe(true);
    expect(second.superseded()).toBe(false);

    // A superseded waiter leaving must not take the newer waiter's claim with it.
    first.release();
    expect(second.superseded()).toBe(false);
    second.release();
    expect(second.superseded()).toBe(true);
  });

  it('keeps separate agents separate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const one = claimWaiter('claude-code:aaaa0000', 'token-1', dir);
    claimWaiter('claude-code:bbbb1111', 'token-2', dir);

    expect(one.superseded()).toBe(false);
  });

  it('stops the watch once superseded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const first = claimWaiter('claude-code:4f2a91c7', 'token-1', dir);
    const stopped = new Promise<void>((resolve) => {
      standDownWhenSuperseded(first, resolve);
    });
    claimWaiter('claude-code:4f2a91c7', 'token-2', dir);

    await expect(stopped).resolves.toBeUndefined();
  });
});

describe('Conductor detection', () => {
  it('recognises a Conductor agent process from its documented environment', () => {
    expect(embeddingHost({ CONDUCTOR_SESSION_ID: 'sess-1' })).toBe('conductor');
    // Conductor's own terminals set the workspace variables but no session id.
    expect(embeddingHost({ CONDUCTOR_WORKSPACE_PATH: '/w/pattaya' })).toBeUndefined();
    expect(embeddingHost({ CONDUCTOR_SESSION_ID: '  ' })).toBeUndefined();
    expect(embeddingHost({})).toBeUndefined();
  });

  it('never hosts a Codex thread whose app-server Conductor owns', () => {
    expect(codexThreadHostable({ CONDUCTOR_SESSION_ID: 'sess-1' })).toBe(false);
    expect(codexThreadHostable({})).toBe(true);
  });

  it("flags a session waiting on Conductor's AskUserQuestion replacement", () => {
    const repos = createRepositories(openDatabase(':memory:'));
    repos.agents.upsert({
      agentId: 'beta',
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
    registerPullEndpoint(repos, 'beta', 'claude-code');

    observeHookEvent(
      repos,
      'beta',
      JSON.stringify({
        session_id: 's-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__conductor__AskUserQuestion',
      }),
    );

    expect(repos.agentEndpoints.getByAgent('beta')?.awaitingUserSince).not.toBeNull();
  });
});

const hookEntry = z.object({
  command: z.string(),
  asyncRewake: z.boolean().optional(),
  timeout: z.number().optional(),
});
const pluginHooks = z.object({
  hooks: z.record(
    z.string(),
    z.array(z.object({ matcher: z.string().optional(), hooks: z.array(hookEntry) })),
  ),
});

describe('relay plugin hooks', () => {
  const raw: unknown = JSON.parse(
    readFileSync(join(process.cwd(), 'plugin', 'concord-relay', 'hooks', 'hooks.json'), 'utf8'),
  );
  const { hooks } = pluginHooks.parse(raw);

  it('arms the rewake waiter after every turn, and never at session start', () => {
    // An SDK session does not finish starting until its SessionStart hooks
    // exit, async or not, so a waiter there would hold the session forever.
    const atStart = (hooks['SessionStart'] ?? []).flatMap((group) => group.hooks);
    expect(atStart.some((hook) => hook.command === 'concord inbox rewake')).toBe(false);
    for (const event of ['Stop']) {
      const rewake = (hooks[event] ?? [])
        .flatMap((group) => group.hooks)
        .filter((hook) => hook.command === 'concord inbox rewake');
      expect(rewake).toHaveLength(1);
      expect(rewake[0]?.asyncRewake).toBe(true);
      // Claude Code enforces timeout on asyncRewake hooks: long enough to outlast a quiet day.
      expect(rewake[0]?.timeout).toBeGreaterThanOrEqual(86_400);
    }
  });

  it("matches Conductor's AskUserQuestion alias for the awaiting-user flag", () => {
    const matchers = (hooks['PreToolUse'] ?? []).map((group) => group.matcher ?? '');
    expect(
      matchers.some((matcher) => matcher.split('|').includes('mcp__conductor__AskUserQuestion')),
    ).toBe(true);
  });
});
