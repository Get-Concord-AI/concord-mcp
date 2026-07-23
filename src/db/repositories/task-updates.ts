import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { parseTaskUpdateRow, type TaskUpdateKind, type TaskUpdateRecord } from '../rows.js';

export interface NewTaskUpdate {
  taskId: string;
  kind: TaskUpdateKind;
  content: string;
  agent: string | null;
}

export interface TaskUpdateRepository {
  create(update: NewTaskUpdate): TaskUpdateRecord;
  listByTask(taskId: string): TaskUpdateRecord[];
}

const rawListSchema = z.array(z.unknown());

export function createTaskUpdateRepository(db: ConcordDatabase): TaskUpdateRepository {
  const insertStmt = db.prepare(`
    INSERT INTO task_updates (task_id, kind, content, agent, created_at)
    VALUES (@task_id, @kind, @content, @agent, @created_at)
  `);
  const getByIdStmt = db.prepare('SELECT * FROM task_updates WHERE id = ?');
  const listByTaskStmt = db.prepare(
    'SELECT * FROM task_updates WHERE task_id = ? ORDER BY created_at ASC, id ASC',
  );

  return {
    create(update) {
      const info = insertStmt.run({
        task_id: update.taskId,
        kind: update.kind,
        content: update.content,
        agent: update.agent,
        created_at: new Date().toISOString(),
      });
      const raw: unknown = getByIdStmt.get(info.lastInsertRowid);
      if (raw === undefined) {
        throw new Error(`Task update ${String(info.lastInsertRowid)} could not be read back`);
      }
      return parseTaskUpdateRow(raw);
    },
    listByTask(taskId) {
      const raw: unknown = listByTaskStmt.all(taskId);
      return rawListSchema.parse(raw).map(parseTaskUpdateRow);
    },
  };
}
