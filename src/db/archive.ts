import { existsSync, renameSync } from 'node:fs';

import Database from 'better-sqlite3';

/** The companions SQLite finds by appending to a database's name. */
const COMPANION_SUFFIXES = ['-wal', '-shm'] as const;

/**
 * Moves a SQLite store to `archivedPath` so it stays readable there, committed
 * work included.
 *
 * SQLite finds a database's write-ahead log by appending `-wal` to its name, so
 * the log moves with the same suffix scheme (`archived-wal`, not
 * `-wal.archived`). It is folded into the database first where possible, so the
 * archive is a single file even if a companion goes astray later. Nothing is
 * migrated: the schema stays whatever wrote the store. Returns the paths now
 * holding it.
 */
export function archiveStore(path: string, archivedPath: string): string[] {
  // Only a real database is opened for writing: closing a writable connection
  // to a file SQLite cannot read deletes the companions beside it.
  if (isSqliteDatabase(path)) {
    try {
      const db = new Database(path, { fileMustExist: true });
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
    } catch {
      // Locked by a running process, say: moved as it is, with its companions
      // named so SQLite still pairs them.
    }
  }
  const moved: string[] = [];
  for (const suffix of ['', ...COMPANION_SUFFIXES]) {
    if (!existsSync(`${path}${suffix}`)) continue;
    renameSync(`${path}${suffix}`, `${archivedPath}${suffix}`);
    moved.push(`${archivedPath}${suffix}`);
  }
  return moved;
}

/** Whether `path` reads as a SQLite database, checked without writing anything. */
function isSqliteDatabase(path: string): boolean {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      db.pragma('schema_version');
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
