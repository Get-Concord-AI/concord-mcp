import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { LOCAL_PROJECT } from '../project-scope-migration.js';
import { parseTaskUpdateRow, type TaskUpdateKind, type TaskUpdateRecord } from '../rows.js';

export interface NewTaskUpdate {
  taskId: string;
  kind: TaskUpdateKind;
  content: string;
  agent: string | null;
}

export interface TaskUpdateRepository {
  create(update: NewTaskUpdate): TaskUpdateRecord;
  get(id: number): TaskUpdateRecord | undefined;
  listByTask(taskId: string): TaskUpdateRecord[];
  /** Replaces an active decision. Throws if it was already replaced, so no link is overwritten. */
  markSuperseded(id: number, supersededBy: number, reason: string | null, at: string): void;
}

const rawListSchema = z.array(z.unknown());

export function createTaskUpdateRepository(
  db: ConcordDatabase,
  project: string = LOCAL_PROJECT,
): TaskUpdateRepository {
  const insertStmt = db.prepare(`
    INSERT INTO task_updates (project, task_id, kind, content, agent, created_at)
    VALUES (@project, @task_id, @kind, @content, @agent, @created_at)
  `);
  const getByIdStmt = db.prepare('SELECT * FROM task_updates WHERE id = ?');
  const getForProjectStmt = db.prepare('SELECT * FROM task_updates WHERE project = ? AND id = ?');
  const listByTaskStmt = db.prepare(
    'SELECT * FROM task_updates WHERE project = ? AND task_id = ? ORDER BY created_at ASC, id ASC',
  );
  const markSupersededStmt = db.prepare(`
    UPDATE task_updates
    SET superseded_by = @superseded_by, supersede_reason = @reason, superseded_at = @at
    WHERE project = @project AND id = @id AND superseded_by IS NULL
  `);

  return {
    create(update) {
      const info = insertStmt.run({
        project,
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
    get(id) {
      const raw: unknown = getForProjectStmt.get(project, id);
      return raw === undefined ? undefined : parseTaskUpdateRow(raw);
    },
    listByTask(taskId) {
      const raw: unknown = listByTaskStmt.all(project, taskId);
      return rawListSchema.parse(raw).map(parseTaskUpdateRow);
    },
    markSuperseded(id, supersededBy, reason, at) {
      const info = markSupersededStmt.run({
        project,
        id,
        superseded_by: supersededBy,
        reason,
        at,
      });
      if (info.changes !== 1) {
        throw new Error(`Decision ${String(id)} was already superseded; nothing was recorded.`);
      }
    },
  };
}
