import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { parseEventRow, type EventRecord, type EventStatus, type ToolName } from '../rows.js';

/** Input for recording a tool-invocation event (adoption + provenance log). */
export interface NewEvent {
  taskId: string | null;
  tool: ToolName;
  status: EventStatus;
  detail: string | null;
}

export interface EventRepository {
  record(event: NewEvent): EventRecord;
  list(): EventRecord[];
  listByTask(taskId: string): EventRecord[];
}

const rawListSchema = z.array(z.unknown());

export function createEventRepository(db: ConcordDatabase): EventRepository {
  const insertStmt = db.prepare(`
    INSERT INTO events (task_id, tool, status, detail, created_at)
    VALUES (@task_id, @tool, @status, @detail, @created_at)
  `);
  const getByIdStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const listStmt = db.prepare('SELECT * FROM events ORDER BY created_at ASC, id ASC');
  const listByTaskStmt = db.prepare(
    'SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC, id ASC',
  );

  return {
    record(event) {
      const info = insertStmt.run({
        task_id: event.taskId,
        tool: event.tool,
        status: event.status,
        detail: event.detail,
        created_at: new Date().toISOString(),
      });
      const raw: unknown = getByIdStmt.get(info.lastInsertRowid);
      if (raw === undefined) {
        throw new Error(`Event ${String(info.lastInsertRowid)} could not be read back`);
      }
      return parseEventRow(raw);
    },
    list() {
      const raw: unknown = listStmt.all();
      return rawListSchema.parse(raw).map(parseEventRow);
    },
    listByTask(taskId) {
      const raw: unknown = listByTaskStmt.all(taskId);
      return rawListSchema.parse(raw).map(parseEventRow);
    },
  };
}
