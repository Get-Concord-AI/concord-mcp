import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { migrations } from './schema.js';

/** An open better-sqlite3 database instance. */
export type ConcordDatabase = Database.Database;

const userVersionSchema = z.number().int().nonnegative();

/**
 * Open (creating if needed) the Concord SQLite database at `filename`, enable
 * WAL + foreign keys, and apply any outstanding migrations. Pass `':memory:'`
 * for an ephemeral database (used in tests).
 */
export function openDatabase(filename: string): ConcordDatabase {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db: ConcordDatabase): void {
  const applied = readUserVersion(db);
  for (let index = applied; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration === undefined) {
      continue;
    }
    db.exec(migration);
    db.pragma(`user_version = ${String(index + 1)}`);
  }
}

function readUserVersion(db: ConcordDatabase): number {
  const raw: unknown = db.pragma('user_version', { simple: true });
  return userVersionSchema.parse(raw);
}
