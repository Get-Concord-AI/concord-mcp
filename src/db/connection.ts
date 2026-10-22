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
  // Concord routinely has several short-lived hook and monitor processes
  // sharing one workspace database. Wait for brief writers instead of making
  // a live inbox watcher exit on the first SQLITE_BUSY response.
  db.pragma('busy_timeout = 5000');
  // Enforcement stays off while migrating: rebuilding a referenced table is
  // only possible without it, and SQLite ignores the pragma inside a transaction.
  db.pragma('foreign_keys = OFF');
  runMigrations(db);
  db.pragma('foreign_keys = ON');
  return db;
}

const foreignKeyViolationsSchema = z.array(z.unknown());

/**
 * Apply each outstanding migration atomically with its version bump, so an
 * interrupted upgrade leaves the previous schema rather than half of the next.
 */
function runMigrations(db: ConcordDatabase): void {
  const applied = readUserVersion(db);
  if (applied > migrations.length) {
    // A newer Concord upgraded this store; this build would misread its rows.
    throw new Error(
      `This Concord database was upgraded by a newer Concord (schema ${String(applied)}; ` +
        `this build knows ${String(migrations.length)}). Upgrade concord, then restart ` +
        'any agent sessions started before the upgrade.',
    );
  }
  for (let index = applied; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration === undefined) {
      continue;
    }
    db.transaction(() => {
      db.exec(migration);
      const violations = foreignKeyViolationsSchema.parse(db.pragma('foreign_key_check'));
      if (violations.length > 0) {
        throw new Error(`Migration ${String(index + 1)} left foreign-key violations.`);
      }
      db.pragma(`user_version = ${String(index + 1)}`);
    })();
  }
}

function readUserVersion(db: ConcordDatabase): number {
  const raw: unknown = db.pragma('user_version', { simple: true });
  return userVersionSchema.parse(raw);
}
