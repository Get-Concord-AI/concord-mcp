import type { ProvenanceEntry, Repositories, ReviewRecord } from '../db/index.js';
import { type ReviewReadyInput } from '../domain/schemas.js';

export interface ReviewReadyResult {
  review: ReviewRecord;
  taskAutoCreated: boolean;
}

function toProvenance(entries: ReviewReadyInput['provenance']): ProvenanceEntry[] {
  return (entries ?? []).map((entry) => ({ field: entry.field, source: entry.source }));
}

/**
 * Record a review packet for a task and mark the task review-ready. Invoked by
 * `handoff` when `ready_for_review` is set (review_ready is no longer a separate
 * tool). Authorization is checked by the owning handoff operation.
 */
export function handleReviewReady(repos: Repositories, input: ReviewReadyInput): ReviewReadyResult {
  const existing = repos.tasks.get(input.task_id);
  if (existing === undefined) {
    throw new Error(`Task ${input.task_id} is not claimed. Call claim_work first.`);
  }

  if (input.expected_version !== undefined && input.expected_version !== existing.version) {
    throw new Error(
      `Task ${input.task_id} version conflict: expected ${String(input.expected_version)}, current ${String(existing.version)}.`,
    );
  }
  const transact = repos.db.transaction(() => {
    const review = repos.reviews.create({
      taskId: input.task_id,
      planSummary: input.plan_summary,
      testsRun: input.tests_run ?? [],
      diffSize: input.diff_size ?? null,
      guardrailsChecked: input.guardrails_checked ?? [],
      assumptions: input.assumptions ?? [],
      openQuestions: input.open_questions ?? [],
      provenance: toProvenance(input.provenance),
    });
    const updated =
      input.expected_version === undefined
        ? repos.tasks.updateStatus(input.task_id, 'review_ready')
        : repos.tasks.transition({
            taskId: input.task_id,
            expectedVersion: input.expected_version,
            status: 'review_ready',
            agentId: existing.agentId,
            assignedAgentId: null,
            leaseExpiresAt: null,
          });
    if (updated === undefined) {
      throw new Error(`Task ${input.task_id} changed while review evidence was recorded.`);
    }
    repos.events.record({
      taskId: input.task_id,
      tool: 'review_ready',
      status: 'success',
      detail: `${String(review.openQuestions.length)} open question(s)`,
    });
    return { review, taskAutoCreated: false };
  });
  return transact();
}

export function formatReviewReadyText(result: ReviewReadyResult): string {
  const { review } = result;
  const lines = [`${review.taskId} is review-ready.`];
  if (result.taskAutoCreated) {
    lines.push('Note: task was not claimed first; created a stub task.');
  }
  lines.push(`Tests run: ${String(review.testsRun.length)}`);
  lines.push(`Guardrails checked: ${String(review.guardrailsChecked.length)}`);
  lines.push(`Open questions: ${String(review.openQuestions.length)}`);
  return lines.join('\n');
}
