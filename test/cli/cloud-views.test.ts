import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CloudRuntime } from '../../src/cloud/runtime.js';
import { inCloud, runCloudTasks, runCloudWho } from '../../src/cli/commands/cloud-views.js';
import { fakeCloud, ok, type Route } from '../cloud/fake-cloud.js';

const NOW = Date.parse('2026-10-09T10:00:00.000Z');

function agent(id: string, agentKey: string, lastSeenAt: string) {
  return {
    id,
    agentKey,
    kind: 'claude-code',
    summary: `${agentKey} work`,
    status: 'active',
    lastSeenAt,
  };
}

function runtimeWith(routes: Route[]): CloudRuntime {
  const repoRoot = mkdtempSync(join(tmpdir(), 'concord-cloud-views-'));
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

const agents: Route = [
  'GET /v1/agents',
  () =>
    ok({
      agents: [
        agent('a1', 'claude-code:aaaa1111', '2026-10-09T09:59:30.000Z'),
        agent('b2', 'codex:bbbb2222', '2026-10-09T09:40:00.000Z'),
        agent('c3', 'gemini:cccc3333', '2026-10-01T00:00:00.000Z'),
      ],
    }),
];

describe('cloud views', () => {
  it('shows who is in the organization, by key, without the long gone', async () => {
    const text = await runCloudWho(runtimeWith([agents]), NOW);

    expect(text).toContain('Workspace: Concord Cloud github.com/acme/app');
    expect(text).toMatch(/claude-code:aaaa1111\s+live\/active/);
    expect(text).toMatch(/codex:bbbb2222\s+idle\/active/);
    expect(text).not.toContain('gemini:cccc3333');
  });

  it('lists the project’s tasks with their holders by key', async () => {
    const text = await runCloudTasks(
      runtimeWith([
        agents,
        [
          'GET /v1/tasks',
          (url) => {
            expect(url.searchParams.get('projectKey')).toBe('github.com/acme/app');
            return ok({
              tasks: [
                {
                  taskKey: 'AUTH-12',
                  title: 'Refactor auth',
                  status: 'active',
                  version: 3,
                  agentId: 'b2',
                  assignedAgentId: null,
                  updatedAt: '2026-10-09T09:00:00.000Z',
                },
              ],
            });
          },
        ],
      ]),
    );

    expect(text).toMatch(
      /AUTH-12\s+active\s+v3\s+codex:bbbb2222\s+2026-10-09T09:00:00.000Z Refactor auth/,
    );
  });

  it('says so when the project has no tasks yet', async () => {
    const text = await runCloudTasks(
      runtimeWith([agents, ['GET /v1/tasks', () => ok({ tasks: [] })]]),
    );

    expect(text).toContain('No tasks yet');
  });

  it('leaves a repository that is not linked to the local commands', async () => {
    const local = mkdtempSync(join(tmpdir(), 'concord-local-'));

    expect(await inCloud(local, () => Promise.resolve('cloud'))).toBeUndefined();
  });

  it('puts the liveliest first, whatever order the cloud answers in', async () => {
    const text = await runCloudWho(
      runtimeWith([
        [
          'GET /v1/agents',
          () =>
            ok({
              agents: [
                agent('b2', 'codex:bbbb2222', '2026-10-09T09:40:00.000Z'),
                agent('a1', 'claude-code:aaaa1111', '2026-10-09T09:59:30.000Z'),
              ],
            }),
        ],
      ]),
      NOW,
    );

    expect(text.indexOf('claude-code:aaaa1111')).toBeLessThan(text.indexOf('codex:bbbb2222'));
  });

  it('says when a full page of tasks may not be all of them', async () => {
    const task = (n: number) => ({
      taskKey: `T-${String(n)}`,
      title: 'work',
      status: 'active',
      version: 1,
      agentId: null,
      assignedAgentId: null,
      updatedAt: '2026-10-09T09:00:00.000Z',
    });
    const text = await runCloudTasks(
      runtimeWith([
        agents,
        ['GET /v1/tasks', () => ok({ tasks: Array.from({ length: 200 }, (_, n) => task(n)) })],
      ]),
    );

    expect(text).toContain('Showing the 200 most recently updated tasks');
  });
});
