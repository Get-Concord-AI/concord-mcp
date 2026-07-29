import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { parseOwnershipEventRow, type OwnershipEventRecord, type TaskStatus } from '../rows.js';

export interface NewOwnershipEvent {
  taskId: string;
  transition: string;
  actorAgentId: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  fromVersion: number;
  toVersion: number;
  reason: string | null;
}

export interface OwnershipEventRepository {
  record(event: NewOwnershipEvent): OwnershipEventRecord;
  listByTask(taskId: string): OwnershipEventRecord[];
}

const rawListSchema = z.array(z.unknown());

export function createOwnershipEventRepository(db: ConcordDatabase): OwnershipEventRepository {
  const insertStmt = db.prepare(`
    INSERT INTO task_ownership_events (
      task_id, transition, actor_agent_id, from_agent_id, to_agent_id,
      from_status, to_status, from_version, to_version, reason, created_at
    ) VALUES (
      @task_id, @transition, @actor_agent_id, @from_agent_id, @to_agent_id,
      @from_status, @to_status, @from_version, @to_version, @reason, @created_at
    )
  `);
  const getStmt = db.prepare('SELECT * FROM task_ownership_events WHERE id = ?');
  const listStmt = db.prepare(
    'SELECT * FROM task_ownership_events WHERE task_id = ? ORDER BY id ASC',
  );

  return {
    record(event) {
      const info = insertStmt.run({
        task_id: event.taskId,
        transition: event.transition,
        actor_agent_id: event.actorAgentId,
        from_agent_id: event.fromAgentId,
        to_agent_id: event.toAgentId,
        from_status: event.fromStatus,
        to_status: event.toStatus,
        from_version: event.fromVersion,
        to_version: event.toVersion,
        reason: event.reason,
        created_at: new Date().toISOString(),
      });
      const raw: unknown = getStmt.get(info.lastInsertRowid);
      if (raw === undefined) {
        throw new Error(`Ownership event ${String(info.lastInsertRowid)} could not be read back`);
      }
      return parseOwnershipEventRow(raw);
    },
    listByTask(taskId) {
      const raw: unknown = listStmt.all(taskId);
      return rawListSchema.parse(raw).map(parseOwnershipEventRow);
    },
  };
}
