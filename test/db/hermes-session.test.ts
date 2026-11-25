import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { hermesSessionCwd } from '../../src/db/hermes-session.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hermesStore(rows: readonly (readonly [string, string | null])[]): {
  root: string;
  statePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'concord-hermes-state-'));
  roots.push(root);
  const statePath = join(root, 'state.db');
  const db = new Database(statePath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT)');
  const insert = db.prepare('INSERT INTO sessions (id, source, cwd) VALUES (?, ?, ?)');
  for (const [id, cwd] of rows) insert.run(id, 'oneshot', cwd);
  db.close();
  return { root, statePath };
}

describe('hermesSessionCwd', () => {
  it('reads the directory Hermes recorded for the session', () => {
    const project = mkdtempSync(join(tmpdir(), 'concord-hermes-project-'));
    roots.push(project);
    const { statePath } = hermesStore([
      ['local-a', project],
      ['local-b', '/somewhere/else'],
    ]);
    expect(hermesSessionCwd(statePath, 'local-a')).toBe(project);
  });

  it('is undefined for an unknown session, a missing directory, or no recorded cwd', () => {
    const { root, statePath } = hermesStore([
      ['gone', join(tmpdir(), 'concord-no-such-dir-0f3a')],
      ['blank', null],
      ['relative', 'repo'],
    ]);
    mkdirSync(join(root, 'repo'));
    expect(hermesSessionCwd(statePath, 'unknown')).toBeUndefined();
    expect(hermesSessionCwd(statePath, 'gone')).toBeUndefined();
    expect(hermesSessionCwd(statePath, 'blank')).toBeUndefined();
    expect(hermesSessionCwd(statePath, 'relative')).toBeUndefined();
  });

  it('is undefined without a store, or with a store of another shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-hermes-state-'));
    roots.push(root);
    expect(hermesSessionCwd(join(root, 'state.db'), 'local-a')).toBeUndefined();
    const other = new Database(join(root, 'other.db'));
    other.exec('CREATE TABLE things (id TEXT)');
    other.close();
    expect(hermesSessionCwd(join(root, 'other.db'), 'local-a')).toBeUndefined();
  });
});
