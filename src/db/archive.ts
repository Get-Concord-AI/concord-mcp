import { existsSync, renameSync } from 'node:fs';

import Database from 'better-sqlite3';

/** The companions SQLite finds by appending to a database's name. */
const COMPANION_SUFFIXES = ['-wal', '-shm'] as const;

/** What archiving a store did: moved it, or left it because a process has it open. */
export type ArchiveResult =
  { readonly kind: 'moved'; readonly paths: readonly string[] } | { readonly kind: 'in-use' };

/**
 * Moves a SQLite store to `archivedPath` so it stays readable there, committed
 * work included. Nothing is migrated: the schema stays whatever wrote the store.
 *
 * A store is moved only when no other process has it open, checked with
 * SQLite's exclusive lock: every WAL-mode connection holds a shared lock, so
 * the lock is granted only to a sole user. Holding it, the write-ahead log is
 * folded into the database. The lock is released for the move itself, because
 * Windows cannot rename an open file, and taken again on the archive after it:
 *
 * - a process that opened the store in between holds the archive now, so the
 *   check fails and the files go back under the names that process is using,
 *   leaving its work in one place;
 * - on Windows the rename itself fails while the store is open.
 *
 * Either way the store is reported in use and left where it was. And no
 * Concord process opens a new store at the old path afterwards: on a linked
 * machine `openContext` refuses, and a server started before the link refuses
 * further opens (`WorkspaceManager`'s `refuseOpen`). Every file
 * moves under the names SQLite pairs (`archived-wal`, never `-wal.archived`),
 * or none does. A file SQLite cannot read is moved as it is, and never opened
 * for writing: closing a writable connection to such a file deletes the
 * companions beside it.
 *
 * `afterMove` runs between the move and the check; tests use it to stand in for
 * a process opening the store at that moment.
 */
export function archiveStore(
  path: string,
  archivedPath: string,
  afterMove: () => void = () => undefined,
): ArchiveResult {
  const database = isSqliteDatabase(path);
  if (database && !foldWriteAheadLog(path)) return { kind: 'in-use' };
  const paths = moveStoreFiles(path, archivedPath);
  if (paths === undefined) return { kind: 'in-use' };
  afterMove();
  if (database && !foldWriteAheadLog(archivedPath)) {
    if (moveStoreFiles(archivedPath, path) === undefined) {
      throw new Error(`Could not put ${archivedPath} back at ${path}; it is open elsewhere.`);
    }
    return { kind: 'in-use' };
  }
  return { kind: 'moved', paths };
}

/** Folds the write-ahead log into the database; false when another process has it open. */
function foldWriteAheadLog(path: string): boolean {
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE; COMMIT;');
    db.pragma('wal_checkpoint(TRUNCATE)');
    return true;
  } catch (error) {
    if (error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY')) {
      return false;
    }
    throw error;
  } finally {
    db.close();
  }
}

/** Errors a rename raises for a file another process has open (Windows). */
const IN_USE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Moves the store and its companions together, or puts back what moved and
 * returns undefined when one is held open elsewhere.
 */
function moveStoreFiles(path: string, archivedPath: string): string[] | undefined {
  const moved: (readonly [string, string])[] = [];
  try {
    for (const suffix of ['', ...COMPANION_SUFFIXES]) {
      if (!existsSync(`${path}${suffix}`)) continue;
      renameSync(`${path}${suffix}`, `${archivedPath}${suffix}`);
      moved.push([`${path}${suffix}`, `${archivedPath}${suffix}`]);
    }
  } catch (error) {
    for (const [from, to] of moved.reverse()) renameSync(to, from);
    if (error instanceof Error && 'code' in error && IN_USE_CODES.has(String(error.code))) {
      return undefined;
    }
    throw error;
  }
  return moved.map(([, to]) => to);
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
