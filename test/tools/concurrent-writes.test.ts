import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleFinishWork, handleStartWork } from '../../src/tools/workflow.js';

/**
 * Two agents are two processes on one WAL database. A write transaction that
 * starts deferred reads an old snapshot; when another agent commits before it
 * writes, SQLite fails the upgrade with SQLITE_BUSY_SNAPSHOT ("database is
 * locked") instead of letting the version check answer. These tests commit
 * from a second connection between the first read and the write, as a racing
 * agent would.
 */
describe('concurrent workflow writes', () => {
  let directory: string;
  let racer: Repositories;
  let winner: Repositories;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'concord-race-'));
    const path = join(directory, 'concord.db');
    racer = createRepositories(openDatabase(path));
    winner = createRepositories(openDatabase(path));
    // The racing agent never waits: either it commits now, or it is refused now.
    winner.db.pragma('busy_timeout = 0');
  });

  afterEach(() => {
    racer.db.close();
    winner.db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  type RaceOutcome = 'not-raced' | 'committed' | 'refused';

  /**
   * `racer`, except that its first task read lets the other agent try to
   * commit first. Only SQLite's busy refusal counts as losing the race; any
   * other failure is a broken test and is rethrown.
   */
  function racedOnFirstRead(commit: () => void): {
    repos: Repositories;
    outcome: () => RaceOutcome;
  } {
    let outcome: RaceOutcome = 'not-raced';
    const tasks = racer.tasks;
    const repos: Repositories = {
      ...racer,
      tasks: {
        ...tasks,
        get: (taskId) => {
          const task = tasks.get(taskId);
          if (outcome === 'not-raced') {
            try {
              commit();
              outcome = 'committed';
            } catch (error) {
              if (
                !(error instanceof Database.SqliteError) ||
                !error.code.startsWith('SQLITE_BUSY')
              ) {
                throw error;
              }
              outcome = 'refused';
            }
          }
          return task;
        },
      },
    };
    return { repos, outcome: () => outcome };
  }

  it('finish_work never surfaces "database is locked" when another agent commits mid-call', () => {
    handleStartWork(racer, {
      task_id: 'RACE-1',
      title: 'Contested task',
      kind: 'test',
      agent_id: 'agent-a',
      expected_files: ['src/race.ts'],
    });

    const { repos, outcome } = racedOnFirstRead(() => {
      handleFinishWork(winner, {
        task_id: 'RACE-1',
        agent_id: 'agent-a',
        expected_version: 1,
        outcome: 'review_ready',
        what_changed: 'The other agent finished first',
      });
    });

    let failure = '';
    try {
      handleFinishWork(repos, {
        task_id: 'RACE-1',
        agent_id: 'agent-a',
        expected_version: 1,
        outcome: 'review_ready',
        what_changed: 'This agent finished too',
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    // The other agent tried while this call held the write lock, and was refused.
    expect(outcome()).toBe('refused');
    expect(failure).not.toMatch(/database is locked|SQLITE_BUSY/u);
    expect(racer.tasks.get('RACE-1')?.version).toBe(2);
  });
});
