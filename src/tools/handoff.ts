import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { HandoffRecord, Repositories } from '../db/index.js';
import { handoffInputShape, type HandoffInput } from '../domain/schemas.js';

export interface HandoffResult {
  handoff: HandoffRecord;
  taskAutoCreated: boolean;
}

/**
 * Record a handoff for a task and mark the task handed off. If the task was
 * never claimed, a minimal stub task is created so the handoff is never lost
 * (the adoption tracker will still show that claim_work was skipped).
 */
export function handleHandoff(repos: Repositories, input: HandoffInput): HandoffResult {
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
      expectedFiles: input.changed_files ?? [],
      modules: [],
      domains: [],
      riskTags: [],
      notes: null,
    });
  }

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

  repos.tasks.updateStatus(input.task_id, 'handed_off');
  repos.events.record({
    taskId: input.task_id,
    tool: 'handoff',
    status: 'success',
    detail: input.status,
  });

  return { handoff, taskAutoCreated };
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
  return lines.join('\n');
}

export function registerHandoff(server: McpServer, repos: Repositories): void {
  server.registerTool(
    'handoff',
    {
      title: 'Hand off work',
      description:
        'Record a concise handoff when an agent finishes or is blocked: what changed, ' +
        'tests run, assumptions, decisions, and guardrails checked. Call this before finishing.',
      inputSchema: handoffInputShape,
    },
    (args) => {
      const result = handleHandoff(repos, args);
      return {
        content: [{ type: 'text', text: formatHandoffText(result) }],
        structuredContent: {
          task_id: result.handoff.taskId,
          handoff_id: result.handoff.id,
          task_auto_created: result.taskAutoCreated,
        },
      };
    },
  );
}
