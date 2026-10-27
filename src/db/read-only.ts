import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

const countRow = z.object({ count: z.number().int().nonnegative() });

/** A store's file and log as they stand: whether each exists, its size and last change. */
function fingerprint(filename: string): string {
  return [filename, `${filename}-wal`]
    .map((path) => {
      const stat = statSync(path, { throwIfNoEntry: false });
      return stat === undefined ? '-' : `${String(stat.size)}@${String(stat.mtimeMs)}`;
    })
    .join('|');
}

/**
 * How many tasks in a Concord store have one of `statuses`, without migrating
 * or writing anything beside it: for reporting on a store this build should
 * not touch, such as one a linked machine left behind. Undefined when the
 * count cannot be trusted: the store is missing, is another schema, changed
 * while it was read, or there is nowhere to read it.
 *
 * The store and its write-ahead log are copied to a temporary directory and
 * read there. Even a read-only SQLite connection creates `-shm` and `-wal`
 * files beside a WAL-mode database, so opening the store in place would leave
 * files in a folder the report says nothing touches. Reading the copied log
 * still counts work committed only to it. The two copies are taken apart, so
 * they agree only if neither file changed meanwhile; a store some session is
 * still writing to gets no count rather than a wrong one.
 *
 * `copyFile` is the copy; tests replace it to change the store mid-copy.
 */
export function countTasksReadOnly(
  filename: string,
  statuses: readonly string[],
  copyFile: (from: string, to: string) => void = copyFileSync,
): number | undefined {
  let scratch: string | undefined;
  try {
    if (!existsSync(filename)) return undefined;
    scratch = mkdtempSync(join(tmpdir(), 'concord-count-'));
    const copy = join(scratch, 'store.db');
    const before = fingerprint(filename);
    copyFile(filename, copy);
    if (existsSync(`${filename}-wal`)) copyFile(`${filename}-wal`, `${copy}-wal`);
    if (fingerprint(filename) !== before) return undefined;

    const db = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      const placeholders = statuses.map(() => '?').join(', ');
      const raw: unknown = db
        .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE status IN (${placeholders})`)
        .get(...statuses);
      return countRow.parse(raw).count;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}
