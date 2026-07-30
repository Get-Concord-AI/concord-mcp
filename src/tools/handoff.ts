import type { HandoffRecord, Repositories, TaskRecord } from '../db/index.js';
import type { HandoffInput } from '../domain/operations.js';
import { handleReviewReady } from './review-ready.js';

export interface HandoffResult {
  handoff: HandoffRecord;
  /** True when `ready_for_review` was set, so a review packet was also produced. */
  reviewReady: boolean;
  task: TaskRecord;
}

/**
 * Record completion/review evidence for an existing task. Ownership transfer
 * is handled separately by transfer_work.
 */
export function handleHandoff(repos: Repositories, input: HandoffInput): HandoffResult {
  const existing = repos.tasks.get(input.task_id);
  if (existing === undefined) {
    throw new Error(`Task ${input.task_id} is not claimed. Call start_work first.`);
  }
  if (input.agent_id !== undefined && repos.agents.get(input.agent_id) === undefined) {
    throw new Error(`Agent ${input.agent_id} is not registered. Call start_work first.`);
  }
  if (existing.agentId !== null && input.agent_id !== existing.agentId) {
    throw new Error(
      `Agent ${input.agent_id ?? '(missing)'} cannot record handoff evidence for ${input.task_id}; current owner is ${existing.agentId}.`,
    );
  }
  if (
    input.ready_for_review === true &&
    existing.agentId !== null &&
    input.expected_version === undefined
  ) {
    throw new Error(
      `expected_version is required to mark owned task ${input.task_id} review-ready.`,
    );
  }
  if (input.expected_version !== undefined && input.expected_version !== existing.version) {
    throw new Error(
      `Task ${input.task_id} version conflict: expected ${String(input.expected_version)}, current ${String(existing.version)}.`,
    );
  }

  const reviewReady = input.ready_for_review === true;
  const transact = repos.db.transaction(() => {
    const handoff = repos.handoffs.create({
      taskId: input.task_id,
      status: input.status,
      changedFiles: input.changed_files ?? [],
      whatChanged: input.what_changed,
      testsRun: input.tests_run ?? [],
      knownRisks: input.known_risks ?? [],
      assumptions: input.assumptions ?? [],
      decisions: input.decisions ?? [],
      guardrailsChecked: input.guardrails_checked ?? [],
      needsReviewFrom: input.needs_review_from ?? [],
      nextSteps: input.next_steps ?? [],
    });
    repos.events.record({
      taskId: input.task_id,
      tool: 'handoff',
      status: 'success',
      detail: input.status,
    });
    if (input.agent_id !== undefined) {
      repos.agents.touch(input.agent_id);
    }
    if (reviewReady) {
      handleReviewReady(repos, {
        task_id: input.task_id,
        plan_summary: input.what_changed,
        tests_run: input.tests_run,
        diff_size: input.diff_size,
        guardrails_checked: input.guardrails_checked,
        assumptions: input.assumptions,
        open_questions: input.open_questions,
        provenance: input.provenance,
        expected_version: input.expected_version,
      });
    }
    const task = repos.tasks.get(input.task_id);
    if (task === undefined) {
      throw new Error(`Task ${input.task_id} disappeared while evidence was recorded.`);
    }
    return { handoff, reviewReady, task };
  });
  return transact();
}
