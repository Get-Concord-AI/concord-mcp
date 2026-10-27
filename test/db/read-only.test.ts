import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { countTasksReadOnly } from '../../src/db/read-only.js';

describe('countTasksReadOnly', () => {
  it('leaves nothing beside the store, and still counts work only in its log', () => {
    // A WAL-mode store whose last commit is only in its log, as a session
    // killed mid-run leaves it: copied while a connection holds it open.
    const live = mkdtempSync(join(tmpdir(), 'concord-live-'));
    const writer = new Database(join(live, 'concord.db'));
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec("CREATE TABLE tasks (status TEXT); INSERT INTO tasks VALUES ('active'), ('done');");
    const folder = mkdtempSync(join(tmpdir(), 'concord-left-'));
    copyFileSync(join(live, 'concord.db'), join(folder, 'concord.db'));
    copyFileSync(join(live, 'concord.db-wal'), join(folder, 'concord.db-wal'));
    writer.close();
    const before = readdirSync(folder).sort();

    expect(countTasksReadOnly(join(folder, 'concord.db'), ['active'])).toBe(1);
    expect(readdirSync(folder).sort()).toEqual(before);
  });

  it('creates no companions for a store without a log either', () => {
    const folder = mkdtempSync(join(tmpdir(), 'concord-left-'));
    const db = new Database(join(folder, 'concord.db'));
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE tasks (status TEXT); INSERT INTO tasks VALUES ('active');");
    db.close();
    expect(readdirSync(folder)).toEqual(['concord.db']);

    expect(countTasksReadOnly(join(folder, 'concord.db'), ['active'])).toBe(1);
    expect(readdirSync(folder)).toEqual(['concord.db']);
  });

  it('is undefined for a missing or unreadable store', () => {
    const folder = mkdtempSync(join(tmpdir(), 'concord-left-'));
    expect(countTasksReadOnly(join(folder, 'missing.db'), ['active'])).toBeUndefined();
  });
});
