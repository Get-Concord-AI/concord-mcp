import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories, TaskUpdateRecord } from '../db/index.js';
import { updateTaskInputShape, type UpdateTaskInput } from '../domain/schemas.js';

export interface UpdateTaskResult {
  update: TaskUpdateRecord;
}

/** Append one durable, task-scoped memory entry for other agents and sessions. */
export function handleUpdateTask(repos: Repositories, input: UpdateTaskInput): UpdateTaskResult {
  const task = repos.tasks.get(input.task_id);
  if (task === undefined) {
    throw new Error(`Task ${input.task_id} is not claimed. Call claim_work first.`);
  }

  const update = repos.taskUpdates.create({
    taskId: input.task_id,
    kind: input.kind,
    content: input.content,
    agent: input.agent ?? task.agent,
  });
  repos.events.record({
    taskId: input.task_id,
    tool: 'update_task',
    status: 'success',
    detail: input.kind,
  });
  if (input.agent_id !== undefined) {
    repos.agents.touch(input.agent_id);
  }
  return { update };
}

export function formatUpdateTaskText(result: UpdateTaskResult): string {
  const author = result.update.agent === null ? '' : ` by ${result.update.agent}`;
  return `Recorded ${result.update.kind} for ${result.update.taskId}${author}: ${result.update.content}`;
}

export function registerUpdateTask(
  server: McpServer,
  repos: Repositories,
  onWrite?: () => void,
): void {
  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description:
        'Append durable task-scoped context such as an intent, decision, assumption, question, ' +
        'answer, blocker, finding, or progress update. The task must be claimed first.',
      inputSchema: updateTaskInputShape,
    },
    (args) => {
      const result = handleUpdateTask(repos, args);
      onWrite?.();
      return {
        content: [{ type: 'text', text: formatUpdateTaskText(result) }],
        structuredContent: {
          update_id: result.update.id,
          task_id: result.update.taskId,
          kind: result.update.kind,
          content: result.update.content,
          agent: result.update.agent,
          created_at: result.update.createdAt,
        },
      };
    },
  );
}
