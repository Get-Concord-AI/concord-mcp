import { existsSync, renameSync } from 'node:fs';

import Database from 'better-sqlite3';

/** The companions SQLite finds by appending to a database's name. */
const COMPANION_SUFFIXES = ['-wal', '-shm'] as const;

/** What archiving a store did: moved it, or left it because a process has it open. */
export type ArchiveResult =
  { readonly kind: 'moved'; readonly paths: readonly string[] } | { readonly kind: 'in-use' };

/**
 * Moves a SQLite store to `archivedPath` so it stays readable there, committed
 * work included.
 *
 * A database is moved only while this process holds its exclusive lock. Every
 * WAL-mode connection holds a shared lock, so the lock is granted only when no
 * other process has the store open, and no commit can land halfway through the
 * move. A store in use is left exactly as it is. Holding the lock, the
 * write-ahead log is folded into the database, and every file moves under the
 * names SQLite pairs (`archived-wal`, never `-wal.archived`). Nothing is
 * migrated: the schema stays whatever wrote the store.
 *
 * A file SQLite cannot read is moved as it is, with its companions named the
 * same way. It is never opened for writing: closing a writable connection to
 * such a file deletes the companions beside it.
 */
export function archiveStore(path: string, archivedPath: string): ArchiveResult {
  if (!isSqliteDatabase(path)) return { kind: 'moved', paths: moveStoreFiles(path, archivedPath) };

  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE; COMMIT;');
    db.pragma('wal_checkpoint(TRUNCATE)');
    return { kind: 'moved', paths: moveStoreFiles(path, archivedPath) };
  } catch (error) {
    if (error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY')) {
      return { kind: 'in-use' };
    }
    throw error;
  } finally {
    db.close();
  }
}

function moveStoreFiles(path: string, archivedPath: string): string[] {
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
