import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { runExportMarkdown } from '../../src/cli/commands/export.js';
import { runHandoffPacket } from '../../src/cli/commands/handoff.js';
import { runReviewPacket } from '../../src/cli/commands/review-packet.js';
import { buildAdoption } from '../../src/domain/adoption.js';
import { openRepositories } from '../../src/db/index.js';
import { CONCORD_INSTRUCTION_VERSION } from '../../src/install/instructions.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleHandoff } from '../../src/tools/handoff.js';
import { handleReviewReady } from '../../src/tools/review-ready.js';

function seededRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'concord-cli2-'));
  mkdirSync(join(dir, '.git'));
  const repos = openRepositories(join(dir, '.concord', 'concord.db'));
  handleClaimWork(repos, { task_id: 'TASK-12', title: 'Add retry', agent: 'claude-code' });
  handleHandoff(repos, { task_id: 'TASK-12', status: 'done', what_changed: 'Queued retries' });
  handleReviewReady(repos, {
    task_id: 'TASK-12',
    plan_summary: 'Queue retries',
    open_questions: ['Sync or queued?'],
  });
  return dir;
}

describe('buildAdoption', () => {
  it('reports which tools were called per task', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    handleClaimWork(repos, { task_id: 'TASK-1', title: 'A' });
    handleClaimWork(repos, { task_id: 'TASK-2', title: 'B' });
    handleHandoff(repos, { task_id: 'TASK-1', status: 'done', what_changed: 'x' });

    const adoption = buildAdoption(repos.events.list());
    const one = adoption.find((a) => a.taskId === 'TASK-1');
    const two = adoption.find((a) => a.taskId === 'TASK-2');
    expect(one).toEqual({
      taskId: 'TASK-1',
      startWork: true,
      finishWork: true,
      reviewReady: false,
    });
    expect(two).toEqual({
      taskId: 'TASK-2',
      startWork: true,
      finishWork: false,
      reviewReady: false,
    });
  });
});

describe('CLI read/export commands', () => {
  let dir: string;
  beforeEach(() => {
    dir = seededRepo();
  });

  it('prints a handoff packet for a task', () => {
    expect(runHandoffPacket(dir, 'TASK-12')).toContain('# Handoff: TASK-12 — Add retry');
  });

  it('explains when a handoff is missing', () => {
    expect(runHandoffPacket(dir, 'TASK-NONE')).toContain('No task TASK-NONE');
  });

  it('prints a review packet for a task', () => {
    const out = runReviewPacket(dir, 'TASK-12');
    expect(out).toContain('# Review Packet: TASK-12');
    expect(out).toContain('Sync or queued?');
  });

  it('exports all artifacts to disk', () => {
    const written = runExportMarkdown(dir);
    expect(written).toContain('REVIEW_PACKET.md');
    expect(existsSync(join(dir, '.concord', 'REVIEW_PACKET.md'))).toBe(true);
  });

  it('doctor reports schema version and adoption', () => {
    const report = runDoctor(dir);
    expect(report).toContain('schema v7, expected v7');
    expect(report).toContain('TASK-12');
    expect(report).toContain('start_work: yes');
    // The resolved workspace path is surfaced so agents don't have to hunt for it.
    expect(report).toContain('repo root');
    expect(report).toContain(join(dir, '.concord'));
  });

  it('doctor reports stale generated Concord instructions', () => {
    writeFileSync(
      join(dir, 'AGENTS.md'),
      '<!-- concord:start -->\n## Concord\nOld tool instructions\n<!-- concord:end -->\n',
    );

    expect(runDoctor(dir)).toContain('instructions stale -> AGENTS.md');
  });

  it('doctor ignores generic headings and reports invalid instruction paths', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '## Concord\nHuman-authored project notes\n');
    mkdirSync(join(dir, 'CLAUDE.md'));

    const report = runDoctor(dir);
    expect(report).not.toContain('stale -> AGENTS.md');
    expect(report).toContain('instructions unreadable -> CLAUDE.md');
  });

  it('doctor requires the workflow marker inside the generated block', () => {
    writeFileSync(
      join(dir, 'AGENTS.md'),
      `<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->\n` +
        '<!-- concord:start -->\n## Concord\nOld generated instructions\n<!-- concord:end -->\n',
    );

    expect(runDoctor(dir)).toContain('instructions stale -> AGENTS.md');
  });
});
