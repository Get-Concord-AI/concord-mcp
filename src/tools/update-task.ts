import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories, TaskUpdateRecord } from '../db/index.js';
import { updateTaskInputShape, type UpdateTaskInput } from '../domain/schemas.js';
import {
  selectToolWorkspace,
  type SelectWorkspace,
  workspaceStructured,
  withWorkspaceText,
} from './workspace-routing.js';

export interface UpdateTaskResult {
  update: TaskUpdateRecord;
}

/** Append one durable, task-scoped memory entry for other agents and sessions. */
export function handleUpdateTask(repos: Repositories, input: UpdateTaskInput): UpdateTaskResult {
  const task = repos.tasks.get(input.task_id);
  if (task === undefined) {
    throw new Error(`Task ${input.task_id} is not claimed. Call claim_work first.`);
  }
  if (input.agent_id !== undefined && repos.agents.get(input.agent_id) === undefined) {
    throw new Error(`Agent ${input.agent_id} is not registered. Call register_agent first.`);
  }
  if (task.agentId !== null) {
    if (input.agent_id === undefined) {
      throw new Error(`Task ${input.task_id} is owned by ${task.agentId}; agent_id is required.`);
    }
    const collaborative = input.kind === 'question' || input.kind === 'finding';
    if (!collaborative && input.agent_id !== task.agentId) {
      throw new Error(
        `Agent ${input.agent_id} cannot record ${input.kind} for ${input.task_id}; current owner is ${task.agentId}.`,
      );
    }
  }

  const update = repos.taskUpdates.create({
    taskId: input.task_id,
    kind: input.kind,
    content: input.content,
    agent: input.agent ?? input.agent_id ?? task.agent,
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
  selectWorkspace?: SelectWorkspace,
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
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleUpdateTask(repos, args);
      onWrite?.();
      return {
        content: [
          { type: 'text', text: withWorkspaceText(formatUpdateTaskText(result), workspace) },
        ],
        structuredContent: {
          ...workspaceStructured(workspace),
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
