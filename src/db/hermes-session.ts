import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

const sessionRow = z.object({ cwd: z.string().nullable() });

/**
 * The working directory Hermes recorded for one of its sessions, read from its
 * `state.db`. Hermes runs agents inside a gateway process whose own cwd and
 * `TERMINAL_CWD` are its install directory or `$HOME`, and its hook payloads
 * carry that cwd too; only the session row says which project the session was
 * started in. Undefined whenever that cannot be read with certainty: no store,
 * another schema, no such session, or a directory that no longer exists.
 *
 * Hermes keeps the store in WAL mode with its `-shm` file beside it while it
 * runs, so a read-only connection here creates nothing new.
 */
export function hermesSessionCwd(statePath: string, sessionId: string): string | undefined {
  if (!existsSync(statePath)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(statePath, { readonly: true, fileMustExist: true, timeout: 2_000 });
    const raw: unknown = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(sessionId);
    if (raw === undefined) return undefined;
    const cwd = sessionRow.parse(raw).cwd?.trim();
    if (cwd === undefined || cwd === '' || !isAbsolute(cwd)) return undefined;
    return statSync(cwd, { throwIfNoEntry: false })?.isDirectory() === true ? cwd : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
