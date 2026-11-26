import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  claimWaiter,
  defaultWaiterDir,
  hostsRewake,
  renderRewake,
  REWAKE_HEADER,
  rewakeWaits,
  standDownWhenSuperseded,
  supersedeWaiter,
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
    expectsReply: true,
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

  it('waits for SDK hosts, which have no plugin monitor to cover them', () => {
    expect(rewakeWaits({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, undefined)).toBe(true);
    // Even a stray receiver beat must not silence an SDK session's only path.
    expect(rewakeWaits({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }, true)).toBe(true);
  });

  it('never waits for -p one-shot runs', () => {
    expect(rewakeWaits({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, false)).toBe(false);
    expect(rewakeWaits({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, undefined)).toBe(false);
  });

  it('waits for an interactive session only while no receiver beats', () => {
    const cli = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
    // The plugin monitor is alive: a waiter would only duplicate it.
    expect(rewakeWaits(cli, true)).toBe(false);
    // The monitor failed to (re)arm — the gap #180 tracks after /resume.
    expect(rewakeWaits(cli, false)).toBe(true);
    // An unknown receiver state still waits: a duplicate waiter is superseded
    // harmlessly, a missing one loses the message.
    expect(rewakeWaits(cli, undefined)).toBe(true);
    expect(rewakeWaits({}, false)).toBe(true);
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

  it('claims under the user Concord dir by default, not the shared temp dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    expect(defaultWaiterDir({ HOME: home, USERPROFILE: home })).toBe(
      join(home, '.concord', 'concord-rewake'),
    );
  });

  it('never writes a claim through a planted symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'untouched');
    const agentId = 'claude-code:symlink01';
    // Plant what an attacker in a shared dir could: a symlink at the
    // predictable claim path pointing at a file of their choosing.
    const key = createHash('sha256').update(agentId).digest('hex').slice(0, 16);
    const claim = join(dir, `${key}.waiter`);
    try {
      symlinkSync(target, claim, 'file');
    } catch {
      // Windows without developer mode cannot create file symlinks.
      return;
    }

    claimWaiter(agentId, 'token-1', dir);

    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(lstatSync(claim).isSymbolicLink()).toBe(false);
    expect(readFileSync(claim, 'utf8').trim()).toBe('token-1');
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

describe('supersedeWaiter', () => {
  it('stands an armed waiter down within a superseded check', () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), 'concord-home-')) };
    const dir = defaultWaiterDir(env);
    const waiter = claimWaiter('claude-code:aaaa0000', 'token-armed', dir);
    expect(waiter.superseded()).toBe(false);

    supersedeWaiter('claude-code:aaaa0000', dir);

    expect(waiter.superseded()).toBe(true);
  });

  it('creates nothing when no waiter is armed — a foreign repository stays clean', () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), 'concord-home-')) };
    const dir = defaultWaiterDir(env);

    supersedeWaiter('claude-code:aaaa0000', dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('leaves the waiter of a different agent alone', () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), 'concord-home-')) };
    const dir = defaultWaiterDir(env);
    const other = claimWaiter('claude-code:bbbb1111', 'token-other', dir);

    supersedeWaiter('claude-code:aaaa0000', dir);

    expect(other.superseded()).toBe(false);
  });
});

describe('waiter claim serialization', () => {
  function claimFile(dir: string, agentId: string): string {
    const key = createHash('sha256').update(agentId).digest('hex').slice(0, 16);
    return join(dir, `${key}.waiter`);
  }

  it('leaves the newer claim untouched when a superseded waiter releases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const agent = 'claude-code:aaaa0000';
    const first = claimWaiter(agent, 'token-old', dir);
    claimWaiter(agent, 'token-new', dir);

    // The pre-check: an already-superseded waiter's release must not touch
    // the newer claim's path or contents at all.
    first.release();

    expect(readFileSync(claimFile(dir, agent), 'utf8').trim()).toBe('token-new');
  });

  it('waits for a lock another process holds instead of writing over it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const agent = 'claude-code:aaaa0000';
    const lock = `${claimFile(dir, agent)}.lock`;
    // The lock is held before the child starts, so no startup race: the child
    // only lifts it 800ms in, and the claim must wait out most of that.
    writeFileSync(lock, 'held');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(lock)}, { force: true }), 800)`,
      ],
      { stdio: 'ignore' },
    );
    try {
      const started = Date.now();
      claimWaiter(agent, 'token-1', dir);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(400);
      // Below the staleness floor: the wait ended because the child lifted
      // the lock, not because it was broken as a dead process's residue.
      expect(elapsed).toBeLessThan(1_900);
      expect(readFileSync(claimFile(dir, agent), 'utf8').trim()).toBe('token-1');
    } finally {
      child.kill();
    }
  });

  it('breaks a lock a dead process left behind instead of waiting it out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const agent = 'claude-code:aaaa0000';
    const lock = `${claimFile(dir, agent)}.lock`;
    writeFileSync(lock, 'dead');
    // Older than the staleness floor: a live holder never yields mid-section,
    // so this can only be a crashed process's residue.
    const stale = new Date(Date.now() - 10_000);
    utimesSync(lock, stale, stale);

    const started = Date.now();
    claimWaiter(agent, 'token-1', dir);

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(readFileSync(claimFile(dir, agent), 'utf8').trim()).toBe('token-1');
  });

  it('leaves no lock residue once the claim is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const agent = 'claude-code:aaaa0000';
    const waiter = claimWaiter(agent, 'token-1', dir);

    expect(existsSync(`${claimFile(dir, agent)}.lock`)).toBe(false);
    waiter.release();
    expect(existsSync(claimFile(dir, agent))).toBe(false);
  });
});

describe('superseded settle window', () => {
  function claimFile(dir: string, agentId: string): string {
    const key = createHash('sha256').update(agentId).digest('hex').slice(0, 16);
    return join(dir, `${key}.waiter`);
  }

  it('is not superseded when the claim file reappears within the settle window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const agent = 'claude-code:aaaa0000';
    const waiter = claimWaiter(agent, 'token-1', dir);
    const path = claimFile(dir, agent);
    // Rewrite the same token a few times over the next hundreds of ms, so one
    // of the writes lands inside the 150ms settle however slow the worker is
    // to start: the absence was a writer mid-flight, not a lost claim.
    const worker = new Worker(
      `const fs = require('node:fs');
       const path = ${JSON.stringify(path)};
       let writes = 0;
       const timer = setInterval(() => {
         fs.writeFileSync(path, 'token-1');
         if (++writes === 20) clearInterval(timer);
       }, 30);`,
      { eval: true },
    );
    try {
      rmSync(path);
      expect(waiter.superseded()).toBe(false);
    } finally {
      await worker.terminate();
    }
  });

  it('is superseded when the claim file stays missing beyond the settle window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-rewake-'));
    const agent = 'claude-code:aaaa0000';
    const waiter = claimWaiter(agent, 'token-1', dir);
    rmSync(claimFile(dir, agent));

    const started = Date.now();
    expect(waiter.superseded()).toBe(true);
    // The settle wait really happened: instant answers cannot tell a slow
    // writer from a lost claim.
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});
