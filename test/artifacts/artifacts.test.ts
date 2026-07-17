import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { writeArtifacts } from '../../src/artifacts/index.js';
import { renderReviewPacketMarkdown } from '../../src/artifacts/review-packet-md.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleHandoff } from '../../src/tools/handoff.js';
import { handleReviewReady } from '../../src/tools/review-ready.js';

describe('renderReviewPacketMarkdown', () => {
  it('uses handoff changed files and decisions when a handoff exists', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    handleClaimWork(repos, {
      task_id: 'TASK-12',
      title: 'Retry',
      expected_files: ['src/expected.ts'],
    });
    const { handoff } = handleHandoff(repos, {
      task_id: 'TASK-12',
      status: 'done',
      what_changed: 'x',
      changed_files: ['src/billing/retry.ts'],
      decisions: ['use a queue'],
    });
    const { review } = handleReviewReady(repos, {
      task_id: 'TASK-12',
      plan_summary: 'Queue retries',
      provenance: [{ field: 'plan', source: 'agent reported' }],
    });
    const task = repos.tasks.get('TASK-12');
    expect(task).toBeDefined();
    if (task === undefined) return;

    const md = renderReviewPacketMarkdown(task, review, handoff);
    expect(md).toContain('# Review Packet: TASK-12 — Retry');
    expect(md).toContain('- `src/billing/retry.ts`');
    expect(md).toContain('- use a queue');
    expect(md).toContain('- plan: agent reported');
  });
});

describe('writeArtifacts', () => {
  let repos: Repositories;
  let dir: string;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    dir = mkdtempSync(join(tmpdir(), 'concord-artifacts-'));
  });

  it('writes WORK_STATE.json and events.jsonl reflecting the DB', () => {
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Retry', modules: ['billing'] });
    writeArtifacts(dir, repos, '2026-07-17T00:00:00.000Z');

    const workState = z
      .object({
        generated_at: z.string(),
        tasks: z.array(z.object({ task_id: z.string(), status: z.string() })),
      })
      .parse(JSON.parse(readFileSync(join(dir, 'WORK_STATE.json'), 'utf8')));
    expect(workState.generated_at).toBe('2026-07-17T00:00:00.000Z');
    expect(workState.tasks[0]?.task_id).toBe('TASK-12');

    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(events).toHaveLength(1);
    expect(z.object({ tool: z.string() }).parse(JSON.parse(events[0] ?? '{}')).tool).toBe(
      'claim_work',
    );
  });

  it('writes HANDOFF.md and REVIEW_PACKET.md after a full flow', () => {
    handleClaimWork(repos, { task_id: 'TASK-12', title: 'Add retry', agent: 'claude-code' });
    handleHandoff(repos, { task_id: 'TASK-12', status: 'done', what_changed: 'Queued retries' });
    handleReviewReady(repos, { task_id: 'TASK-12', plan_summary: 'Queue retries' });
    writeArtifacts(dir, repos, '2026-07-17T00:00:00.000Z');

    expect(readFileSync(join(dir, 'HANDOFF.md'), 'utf8')).toContain(
      '# Handoff: TASK-12 — Add retry',
    );
    expect(readFileSync(join(dir, 'REVIEW_PACKET.md'), 'utf8')).toContain(
      '# Review Packet: TASK-12',
    );
  });
});
