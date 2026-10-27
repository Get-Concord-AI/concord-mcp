import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { countTasksReadOnly } from '../../src/db/read-only.js';

describe('countTasksReadOnly', () => {
  const made: string[] = [];
  const folder = (label: string): string => {
    const path = mkdtempSync(join(tmpdir(), `concord-${label}-`));
    made.push(path);
    return path;
  };

  afterEach(() => {
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  /** A WAL-mode store whose last commit is only in its log, as a session killed mid-run leaves it. */
  function storeWithLog(): string {
    const live = folder('live');
    const left = folder('left');
    const writer = new Database(join(live, 'concord.db'));
    try {
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec(
        "CREATE TABLE tasks (status TEXT); INSERT INTO tasks VALUES ('active'), ('done');",
      );
      // Copied while the writer holds the commit in its log, uncheckpointed.
      copyFileSync(join(live, 'concord.db'), join(left, 'concord.db'));
      copyFileSync(join(live, 'concord.db-wal'), join(left, 'concord.db-wal'));
    } finally {
      writer.close();
    }
    return join(left, 'concord.db');
  }

  it('leaves nothing beside the store, and still counts work only in its log', () => {
    const store = storeWithLog();
    const before = readdirSync(join(store, '..')).sort();

    expect(countTasksReadOnly(store, ['active'])).toBe(1);
    expect(readdirSync(join(store, '..')).sort()).toEqual(before);
  });

  it('creates no companions for a store without a log either', () => {
    const dir = folder('plain');
    const db = new Database(join(dir, 'concord.db'));
    try {
      db.pragma('journal_mode = WAL');
      db.exec("CREATE TABLE tasks (status TEXT); INSERT INTO tasks VALUES ('active');");
    } finally {
      db.close();
    }
    expect(readdirSync(dir)).toEqual(['concord.db']);

    expect(countTasksReadOnly(join(dir, 'concord.db'), ['active'])).toBe(1);
    expect(readdirSync(dir)).toEqual(['concord.db']);
  });

  it('gives no count for a store that changes while it is copied', () => {
    const store = storeWithLog();
    // A session still writing: the log grows between the two copies.
    const writing = (from: string, to: string) => {
      copyFileSync(from, to);
      if (from === store) appendFileSync(`${store}-wal`, Buffer.alloc(16));
    };

    expect(countTasksReadOnly(store, ['active'], writing)).toBeUndefined();
  });

  it('gives no count, rather than failing, when there is nowhere to copy to', () => {
    const store = storeWithLog();
    // os.tmpdir() reads TMPDIR on POSIX and TEMP, then TMP, on Windows.
    const nowhere = join(folder('gone'), 'missing', 'deeper');
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, nowhere);
    try {
      expect(countTasksReadOnly(store, ['active'])).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gives no count for a missing or unreadable store', () => {
    const dir = folder('bad');
    expect(countTasksReadOnly(join(dir, 'missing.db'), ['active'])).toBeUndefined();
    appendFileSync(join(dir, 'garbage.db'), 'not a database');
    expect(countTasksReadOnly(join(dir, 'garbage.db'), ['active'])).toBeUndefined();
  });

  it('leaves no temporary copy behind, counted or not', () => {
    const store = storeWithLog();
    const scratch: string[] = [];
    const tracking = (from: string, to: string) => {
      scratch.push(dirname(to));
      copyFileSync(from, to);
    };

    expect(countTasksReadOnly(store, ['active'], tracking)).toBe(1);
    expect(
      countTasksReadOnly(store, ['active'], (from, to) => {
        tracking(from, to);
        throw new Error('disk full');
      }),
    ).toBeUndefined();

    expect(scratch.length).toBeGreaterThan(0);
    for (const dir of scratch) expect(existsSync(dir)).toBe(false);
  });
});
