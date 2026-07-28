import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { HandoffRecord, Repositories, TaskRecord } from '../db/index.js';
import { handoffInputShape, type HandoffInput } from '../domain/schemas.js';
import { handleReviewReady } from './review-ready.js';
import {
  selectToolWorkspace,
  type SelectWorkspace,
  workspaceStructured,
  withWorkspaceText,
} from './workspace-routing.js';

export interface HandoffResult {
  handoff: HandoffRecord;
  taskAutoCreated: boolean;
  /** True when `ready_for_review` was set, so a review packet was also produced. */
  reviewReady: boolean;
  task: TaskRecord;
}

/**
 * Record completion/review evidence for an existing task. Ownership transfer
 * is handled separately by offer_handoff/accept_handoff.
 */
export function handleHandoff(repos: Repositories, input: HandoffInput): HandoffResult {
  const existing = repos.tasks.get(input.task_id);
  if (existing === undefined) {
    throw new Error(`Task ${input.task_id} is not claimed. Call claim_work first.`);
  }
  if (input.agent_id !== undefined && repos.agents.get(input.agent_id) === undefined) {
    throw new Error(`Agent ${input.agent_id} is not registered. Call register_agent first.`);
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
        agent_id: input.agent_id,
        expected_version: input.expected_version,
      });
    }
    const task = repos.tasks.get(input.task_id);
    if (task === undefined) {
      throw new Error(`Task ${input.task_id} disappeared while evidence was recorded.`);
    }
    return { handoff, taskAutoCreated: false, reviewReady, task };
  });
  return transact();
}

export function formatHandoffText(result: HandoffResult): string {
  const { handoff } = result;
  const lines = [`Recorded handoff for ${handoff.taskId} (status: ${handoff.status}).`];
  if (result.taskAutoCreated) {
    lines.push('Note: task was not claimed first; created a stub task.');
  }
  lines.push(`Changed files: ${String(handoff.changedFiles.length)}`);
  if (handoff.needsReviewFrom.length > 0) {
    lines.push(`Needs review from: ${handoff.needsReviewFrom.join(', ')}`);
  }
  if (result.reviewReady) {
    lines.push('Marked review-ready; REVIEW_PACKET.md regenerated.');
  }
  return lines.join('\n');
}

export function registerHandoff(
  server: McpServer,
  repos: Repositories,
  onWrite?: () => void,
  selectWorkspace?: SelectWorkspace,
): void {
  server.registerTool(
    'handoff',
    {
      title: 'Hand off work',
      description:
        'Record completion/review evidence for owned work: what changed, tests, assumptions, ' +
        'decisions, and guardrails. This does not transfer ownership; use offer_handoff for that. ' +
        'Set ready_for_review before a PR to also produce a review packet.',
      inputSchema: handoffInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleHandoff(repos, args);
      onWrite?.();
      return {
        content: [{ type: 'text', text: withWorkspaceText(formatHandoffText(result), workspace) }],
        structuredContent: {
          ...workspaceStructured(workspace),
          task_id: result.handoff.taskId,
          handoff_id: result.handoff.id,
          task_auto_created: result.taskAutoCreated,
          review_ready: result.reviewReady,
          status: result.task.status,
          version: result.task.version,
          agent_id: result.task.agentId,
        },
      };
    },
  );
}
