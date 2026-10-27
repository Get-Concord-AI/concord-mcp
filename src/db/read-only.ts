import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

const countRow = z.object({ count: z.number().int().nonnegative() });

/**
 * How many tasks in a Concord store have one of `statuses`, without migrating
 * or writing anything beside it: for reporting on a store this build should
 * not touch, such as one a linked machine left behind. Undefined when the
 * store cannot be read as one (missing, or another schema).
 *
 * The store and its write-ahead log are copied to a temporary directory and
 * read there. Even a read-only SQLite connection creates `-shm` and `-wal`
 * files beside a WAL-mode database, so opening the store in place would leave
 * files in a folder the report says nothing touches. Reading the copied log
 * still counts work committed only to it.
 */
export function countTasksReadOnly(
  filename: string,
  statuses: readonly string[],
): number | undefined {
  if (!existsSync(filename)) return undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'concord-count-'));
  try {
    const copy = join(scratch, 'store.db');
    copyFileSync(filename, copy);
    if (existsSync(`${filename}-wal`)) copyFileSync(`${filename}-wal`, `${copy}-wal`);
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
    rmSync(scratch, { recursive: true, force: true });
  }
}
