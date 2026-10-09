import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { CloudRuntime } from '../../src/cloud/runtime.js';
import {
  decideCloudPreToolUse,
  handleCloudSessionStart,
} from '../../src/cli/commands/cloud-hooks.js';
import { cloudAccess } from '../../src/cli/commands/cloud-inbox.js';
import { ensureMachineKey, writeCredentials, writeLink } from '../../src/cloud/settings.js';
import { fakeCloud, ok, type Route } from '../cloud/fake-cloud.js';

const SELF = 'claude-code:aaaa1111';
const NOW = new Date().toISOString();

function claim(taskKey: string, agentKey: string) {
  return { file: 'src/a.ts', taskKey, title: `${taskKey} work`, status: 'active', agentKey };
}

function peer(agentKey: string, lastSeenAt: string) {
  return {
    id: `${agentKey}-uuid`,
    agentKey,
    kind: 'codex',
    summary: 'busy',
    status: 'active',
    lastSeenAt,
  };
}

describe('cloud hooks', () => {
  let repoRoot: string;
  let asked: URL[];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'concord-cloud-hooks-'));
    asked = [];
  });

  function runtimeWith(routes: Route[]): CloudRuntime {
    return {
      apiUrl: 'https://api.example.test',
      bearer: () => Promise.resolve('token'),
      machineKey: 'machine-1',
      projectKey: 'github.com/acme/app',
      repoRoot,
      checkoutRoot: repoRoot,
      fetch: fakeCloud(routes).fetch,
    };
  }

  const claims = (...held: ReturnType<typeof claim>[]): Route[] => [
    [
      'GET /v1/claims',
      (url) => {
        asked.push(url);
        return ok({ claims: held });
      },
    ],
  ];
  const editing = (path: string) => JSON.stringify({ tool_input: { file_path: path } });

  it('asks the cloud about the edited file, by its path in the repository', async () => {
    const decision = await decideCloudPreToolUse(
      runtimeWith(claims()),
      editing(join(repoRoot, 'src', 'a.ts')),
      undefined,
      SELF,
    );

    expect(decision.result).toBe('clear');
    expect(asked[0]?.searchParams.get('projectKey')).toBe('github.com/acme/app');
    expect(asked[0]?.searchParams.getAll('file')).toEqual(['src/a.ts']);
  });

  it('blocks an edit to a file another task holds, when CONCORD_TASK names your own', async () => {
    const decision = await decideCloudPreToolUse(
      runtimeWith(claims(claim('OTHER-1', 'codex:bbbb2222'))),
      editing(join(repoRoot, 'src', 'a.ts')),
      'MINE-1',
      SELF,
    );

    expect(decision).toMatchObject({ block: true, result: 'blocked', conflictingTaskCount: 1 });
    expect(decision.message).toContain('OTHER-1 (OTHER-1 work, codex:bbbb2222)');
  });

  it('only warns without CONCORD_TASK, as the local guard does', async () => {
    const decision = await decideCloudPreToolUse(
      runtimeWith(claims(claim('OTHER-1', 'codex:bbbb2222'))),
      editing('src/a.ts'),
      undefined,
      SELF,
    );

    expect(decision).toMatchObject({ block: false, result: 'warned' });
  });

  it('never counts this session’s own claims as a conflict', async () => {
    const decision = await decideCloudPreToolUse(
      runtimeWith(claims(claim('MINE-1', SELF))),
      editing('src/a.ts'),
      'SOMETHING-ELSE',
      SELF,
    );

    expect(decision).toMatchObject({ block: false, result: 'clear' });
  });

  it('asks nothing about a file outside the repository', async () => {
    const decision = await decideCloudPreToolUse(
      runtimeWith(claims(claim('OTHER-1', 'codex:bbbb2222'))),
      editing('/etc/hosts'),
      'MINE-1',
      SELF,
    );

    expect(decision.result).toBe('not_applicable');
    expect(asked).toEqual([]);
  });

  it('lets the edit through, saying so, when the cloud cannot answer', async () => {
    const decision = await decideCloudPreToolUse(
      runtimeWith([['GET /v1/claims', () => ({ status: 503, json: { error: 'down' } })]]),
      editing('src/a.ts'),
      'MINE-1',
      SELF,
    );

    expect(decision.block).toBe(false);
    expect(decision.message).toContain('editing anyway');
  });

  it('tells a starting session who else is in the organization, not itself', async () => {
    const result = await handleCloudSessionStart(
      runtimeWith([
        ['POST /v1/machines', () => ok({ machine: { id: 'm-uuid' } })],
        ['POST /v1/agents', () => ok({ agent: { id: 'a-uuid' } })],
        ['PUT /v1/agents/a-uuid/endpoint', () => ok({ endpoint: {} })],
        [
          'GET /v1/agents',
          () =>
            ok({
              agents: [
                peer(SELF, NOW),
                peer('codex:bbbb2222', NOW),
                peer('gemini:cccc3333', '2020-01-01T00:00:00.000Z'),
              ],
            }),
        ],
      ]),
      JSON.stringify({ session_id: 'session-1', cwd: repoRoot }),
      { CONCORD_AGENT_ID: SELF },
    );

    expect(result.agentId).toBe(SELF);
    expect(result.message).toContain('Who else is here:');
    expect(result.message).toContain('codex:bbbb2222 [live/active]: busy');
    expect(result.message).not.toContain(`  - ${SELF}`);
    expect(result.message).not.toContain('gemini:cccc3333');
  });

  it('checks an edit made in a linked worktree against the project’s claims', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'concord-worktree-')));
    const primary = join(base, 'primary');
    const worktree = join(base, 'feature');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    mkdirSync(primary);
    git(primary, 'init', '-q');
    git(
      primary,
      '-c',
      'user.email=t@example.test',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    git(primary, 'worktree', 'add', '-q', worktree);
    writeLink(primary, { apiUrl: 'https://api.example.test', projectKey: 'github.com/acme/app' });
    const home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    const env = { HOME: home };
    writeCredentials(env, { apiUrl: 'https://api.example.test', apiKey: 'cc_test' });
    ensureMachineKey(env, () => 'machine-1');

    const access = cloudAccess(worktree, {}, env);
    if (access.kind !== 'cloud') throw new Error(`expected a cloud runtime, got ${access.kind}`);
    const decision = await decideCloudPreToolUse(
      { ...access.runtime, fetch: fakeCloud(claims(claim('OTHER-1', 'codex:bbbb2222'))).fetch },
      editing(join(worktree, 'src', 'a.ts')),
      'MINE-1',
      SELF,
    );

    expect(access.runtime.checkoutRoot).toBe(worktree);
    expect(decision.result).toBe('blocked');
    expect(asked[0]?.searchParams.getAll('file')).toEqual(['src/a.ts']);
  });
});
