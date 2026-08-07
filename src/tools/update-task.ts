import type { Repositories, TaskRecord, TaskUpdateRecord } from '../db/index.js';
import type { UpdateTaskInput } from '../domain/operations.js';

export interface UpdateTaskResult {
  update: TaskUpdateRecord;
  task: TaskRecord;
}

/** Append one durable, task-scoped memory entry for other agents and sessions. */
export function handleUpdateTask(repos: Repositories, input: UpdateTaskInput): UpdateTaskResult {
  const task = repos.tasks.get(input.task_id);
  if (task === undefined) {
    throw new Error(`Task ${input.task_id} is not claimed. Call start_work first.`);
  }
  if (input.agent_id !== undefined && repos.agents.get(input.agent_id) === undefined) {
    throw new Error(`Agent ${input.agent_id} is not registered. Call start_work first.`);
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

  const transact = repos.db.transaction(() => {
    const update = repos.taskUpdates.create({
      taskId: input.task_id,
      kind: input.kind,
      content: input.content,
      agent: input.agent ?? input.agent_id ?? task.agent,
    });
    const updatedTask = repos.tasks.touchActivity(input.task_id);
    if (updatedTask === undefined) {
      throw new Error(`Task ${input.task_id} disappeared while its update was recorded.`);
    }
    repos.events.record({
      taskId: input.task_id,
      tool: 'update_task',
      status: 'success',
      detail: input.kind,
    });
    if (input.agent_id !== undefined) {
      repos.agents.touch(input.agent_id);
    }
    return { update, task: updatedTask };
  });
  return transact();
}
