import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type {
  HandoffRecord,
  Repositories,
  ReviewRecord,
  TaskRecord,
  TaskUpdateRecord,
} from '../db/index.js';
import { detectOverlaps, type OverlapWarning } from '../domain/overlap.js';
import { getTaskContextInputShape, type GetTaskContextInput } from '../domain/schemas.js';

export interface TaskContextResult {
  task: TaskRecord;
  updates: TaskUpdateRecord[];
  latestHandoff: HandoffRecord | undefined;
  latestReview: ReviewRecord | undefined;
  overlaps: OverlapWarning[];
}

export function handleGetTaskContext(
  repos: Repositories,
  input: GetTaskContextInput,
): TaskContextResult {
  const task = repos.tasks.get(input.task_id);
  if (!task) {
    throw new Error(`Task "${input.task_id}" is not claimed. Call claim_work first.`);
  }

  const overlaps =
    task.status === 'active'
      ? detectOverlaps(
          {
            taskId: task.taskId,
            parentTaskId: task.parentTaskId,
            expectedFiles: task.expectedFiles,
            modules: task.modules,
            domains: task.domains,
            riskTags: task.riskTags,
          },
          repos.tasks
            .list()
            .filter(
              (candidate) => candidate.taskId !== task.taskId && candidate.status === 'active',
            ),
        )
      : [];

  return {
    task,
    updates: repos.taskUpdates.listByTask(task.taskId),
    latestHandoff: repos.handoffs.latestForTask(task.taskId),
    latestReview: repos.reviews.latestForTask(task.taskId),
    overlaps,
  };
}

function formatContext(result: TaskContextResult): string {
  const updates =
    result.updates.length === 0
      ? '  None'
      : result.updates
          .map(
            (update) => `  [${update.kind}] ${update.content} — ${update.agent ?? 'unknown agent'}`,
          )
          .join('\n');
  const overlaps =
    result.overlaps.length === 0
      ? '  None'
      : result.overlaps
          .map((overlap) => `  ${overlap.taskId}: ${overlap.reasons.join('; ')}`)
          .join('\n');

  return [
    `${result.task.taskId} — ${result.task.title}`,
    `Status: ${result.task.status}`,
    `Agent: ${result.task.agent ?? 'unassigned'}`,
    `Notes: ${result.task.notes ?? 'not recorded'}`,
    'Updates:',
    updates,
    'Live overlaps:',
    overlaps,
    `Latest handoff: ${result.latestHandoff?.whatChanged ?? 'none'}`,
    `Review plan: ${result.latestReview?.planSummary ?? 'not submitted'}`,
  ].join('\n');
}

export function registerGetTaskContext(server: McpServer, repos: Repositories): void {
  server.registerTool(
    'get_task_context',
    {
      title: 'Get task context',
      description:
        "Read a claimed task's scope, ordered updates, latest handoff and review, and current overlaps.",
      inputSchema: getTaskContextInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => {
      const result = handleGetTaskContext(repos, input);
      return {
        content: [{ type: 'text', text: formatContext(result) }],
        structuredContent: {
          task: result.task,
          updates: result.updates,
          latest_handoff: result.latestHandoff ?? null,
          latest_review: result.latestReview ?? null,
          overlaps: result.overlaps,
        },
      };
    },
  );
}
