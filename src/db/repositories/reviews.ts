import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import {
  parseReviewRow,
  serializeProvenance,
  serializeStringArray,
  type ProvenanceEntry,
  type ReviewRecord,
} from '../rows.js';

/** Input for recording a review packet. Array fields default to `[]` at the caller. */
export interface NewReview {
  taskId: string;
  planSummary: string;
  testsRun: readonly string[];
  diffSize: string | null;
  guardrailsChecked: readonly string[];
  assumptions: readonly string[];
  openQuestions: readonly string[];
  provenance: readonly ProvenanceEntry[];
}

export interface ReviewRepository {
  create(review: NewReview): ReviewRecord;
  listByTask(taskId: string): ReviewRecord[];
  latestForTask(taskId: string): ReviewRecord | undefined;
}

const rawListSchema = z.array(z.unknown());

export function createReviewRepository(db: ConcordDatabase): ReviewRepository {
  const insertStmt = db.prepare(`
    INSERT INTO reviews (
      task_id, plan_summary, tests_run, diff_size, guardrails_checked,
      assumptions, open_questions, provenance, created_at
    ) VALUES (
      @task_id, @plan_summary, @tests_run, @diff_size, @guardrails_checked,
      @assumptions, @open_questions, @provenance, @created_at
    )
  `);
  const getByIdStmt = db.prepare('SELECT * FROM reviews WHERE id = ?');
  const listByTaskStmt = db.prepare(
    'SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at ASC, id ASC',
  );
  const latestStmt = db.prepare(
    'SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
  );

  return {
    create(review) {
      const info = insertStmt.run({
        task_id: review.taskId,
        plan_summary: review.planSummary,
        tests_run: serializeStringArray(review.testsRun),
        diff_size: review.diffSize,
        guardrails_checked: serializeStringArray(review.guardrailsChecked),
        assumptions: serializeStringArray(review.assumptions),
        open_questions: serializeStringArray(review.openQuestions),
        provenance: serializeProvenance(review.provenance),
        created_at: new Date().toISOString(),
      });
      const raw: unknown = getByIdStmt.get(info.lastInsertRowid);
      if (raw === undefined) {
        throw new Error(`Review ${String(info.lastInsertRowid)} could not be read back`);
      }
      return parseReviewRow(raw);
    },
    listByTask(taskId) {
      const raw: unknown = listByTaskStmt.all(taskId);
      return rawListSchema.parse(raw).map(parseReviewRow);
    },
    latestForTask(taskId) {
      const raw: unknown = latestStmt.get(taskId);
      if (raw === undefined) {
        return undefined;
      }
      return parseReviewRow(raw);
    },
  };
}
