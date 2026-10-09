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
  latestForTasks(taskIds: readonly string[]): ReviewRecord[];
}

const rawListSchema = z.array(z.unknown());
const REVIEW_QUERY_CHUNK_SIZE = 500;

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
    latestForTasks(taskIds) {
      if (taskIds.length === 0) return [];
      const uniqueTaskIds = [...new Set(taskIds)];
      const reviews: ReviewRecord[] = [];

      for (let offset = 0; offset < uniqueTaskIds.length; offset += REVIEW_QUERY_CHUNK_SIZE) {
        const chunk = uniqueTaskIds.slice(offset, offset + REVIEW_QUERY_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const raw: unknown = db
          .prepare(
            `SELECT r.*
             FROM reviews r
             JOIN (
               SELECT task_id, MAX(id) AS id
               FROM reviews
               WHERE task_id IN (${placeholders})
               GROUP BY task_id
             ) latest ON latest.id = r.id`,
          )
          .all(...chunk);
        reviews.push(...rawListSchema.parse(raw).map(parseReviewRow));
      }

      return reviews.sort((a, b) => a.taskId.localeCompare(b.taskId));
    },
  };
}
