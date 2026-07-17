import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { parseHandoffRow, serializeStringArray, type HandoffRecord } from '../rows.js';

/** Input for recording a handoff. Array fields default to `[]` at the caller. */
export interface NewHandoff {
  taskId: string;
  status: string;
  changedFiles: readonly string[];
  whatChanged: string;
  testsRun: readonly string[];
  knownRisks: readonly string[];
  assumptions: readonly string[];
  decisions: readonly string[];
  guardrailsChecked: readonly string[];
  needsReviewFrom: readonly string[];
  nextSteps: readonly string[];
}

export interface HandoffRepository {
  create(handoff: NewHandoff): HandoffRecord;
  listByTask(taskId: string): HandoffRecord[];
  latestForTask(taskId: string): HandoffRecord | undefined;
}

const rawListSchema = z.array(z.unknown());

export function createHandoffRepository(db: ConcordDatabase): HandoffRepository {
  const insertStmt = db.prepare(`
    INSERT INTO handoffs (
      task_id, status, changed_files, what_changed, tests_run, known_risks,
      assumptions, decisions, guardrails_checked, needs_review_from, next_steps,
      created_at
    ) VALUES (
      @task_id, @status, @changed_files, @what_changed, @tests_run, @known_risks,
      @assumptions, @decisions, @guardrails_checked, @needs_review_from, @next_steps,
      @created_at
    )
  `);
  const getByIdStmt = db.prepare('SELECT * FROM handoffs WHERE id = ?');
  const listByTaskStmt = db.prepare(
    'SELECT * FROM handoffs WHERE task_id = ? ORDER BY created_at ASC, id ASC',
  );
  const latestStmt = db.prepare(
    'SELECT * FROM handoffs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
  );

  return {
    create(handoff) {
      const info = insertStmt.run({
        task_id: handoff.taskId,
        status: handoff.status,
        changed_files: serializeStringArray(handoff.changedFiles),
        what_changed: handoff.whatChanged,
        tests_run: serializeStringArray(handoff.testsRun),
        known_risks: serializeStringArray(handoff.knownRisks),
        assumptions: serializeStringArray(handoff.assumptions),
        decisions: serializeStringArray(handoff.decisions),
        guardrails_checked: serializeStringArray(handoff.guardrailsChecked),
        needs_review_from: serializeStringArray(handoff.needsReviewFrom),
        next_steps: serializeStringArray(handoff.nextSteps),
        created_at: new Date().toISOString(),
      });
      const raw: unknown = getByIdStmt.get(info.lastInsertRowid);
      if (raw === undefined) {
        throw new Error(`Handoff ${String(info.lastInsertRowid)} could not be read back`);
      }
      return parseHandoffRow(raw);
    },
    listByTask(taskId) {
      const raw: unknown = listByTaskStmt.all(taskId);
      return rawListSchema.parse(raw).map(parseHandoffRow);
    },
    latestForTask(taskId) {
      const raw: unknown = latestStmt.get(taskId);
      if (raw === undefined) {
        return undefined;
      }
      return parseHandoffRow(raw);
    },
  };
}
