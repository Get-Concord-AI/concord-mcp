import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ProvenanceEntry, Repositories, ReviewRecord } from '../db/index.js';
import { reviewReadyInputShape, type ReviewReadyInput } from '../domain/schemas.js';

export interface ReviewReadyResult {
  review: ReviewRecord;
  taskAutoCreated: boolean;
}

function toProvenance(entries: ReviewReadyInput['provenance']): ProvenanceEntry[] {
  return (entries ?? []).map((entry) => ({ field: entry.field, source: entry.source }));
}

/**
 * Record a review packet for a task and mark the task review-ready. Like
 * handoff, this auto-creates a stub task if the work was never claimed.
 */
export function handleReviewReady(repos: Repositories, input: ReviewReadyInput): ReviewReadyResult {
  const existing = repos.tasks.get(input.task_id);
  const taskAutoCreated = existing === undefined;
  if (existing === undefined) {
    repos.tasks.create({
      taskId: input.task_id,
      title: input.task_id,
      owner: null,
      agent: null,
      branch: null,
      worktree: null,
      expectedFiles: [],
      modules: [],
      domains: [],
      riskTags: [],
      notes: null,
    });
  }

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

  repos.tasks.updateStatus(input.task_id, 'review_ready');
  repos.events.record({
    taskId: input.task_id,
    tool: 'review_ready',
    status: 'success',
    detail: `${String(review.openQuestions.length)} open question(s)`,
  });

  return { review, taskAutoCreated };
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

export function registerReviewReady(server: McpServer, repos: Repositories): void {
  server.registerTool(
    'review_ready',
    {
      title: 'Mark review-ready',
      description:
        'Record review evidence before a PR: plan summary, tests run, diff size, guardrails ' +
        'checked, assumptions, open questions, and provenance. Call this before opening a PR.',
      inputSchema: reviewReadyInputShape,
    },
    (args) => {
      const result = handleReviewReady(repos, args);
      return {
        content: [{ type: 'text', text: formatReviewReadyText(result) }],
        structuredContent: {
          task_id: result.review.taskId,
          review_id: result.review.id,
          open_questions: result.review.openQuestions.length,
          task_auto_created: result.taskAutoCreated,
        },
      };
    },
  );
}
