import Database from 'better-sqlite3';
import { z } from 'zod';

const countRow = z.object({ count: z.number().int().nonnegative() });

/**
 * How many tasks in a Concord store have one of `statuses`, read without
 * migrating or writing anything: for reporting on a store this build should
 * not touch, such as one a linked machine left behind. Undefined when the
 * store cannot be read as one (missing, locked, or another schema).
 */
export function countTasksReadOnly(
  filename: string,
  statuses: readonly string[],
): number | undefined {
  try {
    const db = new Database(filename, { readonly: true, fileMustExist: true });
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
  }
}
