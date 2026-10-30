import { deriveLiveness } from '../domain/presence.js';
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
      const owner = repos.agents.get(task.agentId);
      const liveness =
        owner === undefined ? 'unregistered' : deriveLiveness(owner.lastSeen, Date.now());
      const recovery =
        liveness === 'away' || liveness === 'archived' || liveness === 'unregistered'
          ? ` Owner ${task.agentId} is ${liveness}. A registered agent for the same human owner can call transfer_work with action: 'reassign', task_id: '${input.task_id}', agent_id: '${input.agent_id}', expected_version: ${String(task.version)}, to_agent_id: '${input.agent_id}', force: true, and reason: 'Previous owner inactive', then accept the assignment.`
          : '';
      throw new Error(
        `Agent ${input.agent_id} cannot record ${input.kind} for ${input.task_id}; current owner is ${task.agentId}.${recovery}`,
      );
    }
  }

  const superseded = findSupersededDecision(repos, input);

  const transact = repos.db.transaction(() => {
    const update = repos.taskUpdates.create({
      taskId: input.task_id,
      kind: input.kind,
      content: input.content,
      agent: input.agent ?? input.agent_id ?? task.agent,
    });
    if (superseded !== undefined) {
      repos.taskUpdates.markSuperseded(superseded.id, update.id, input.supersede_reason ?? null);
    }
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

/**
 * A decision can replace one earlier decision on the same task. Only a live,
 * not-yet-replaced decision can be replaced, and the reason needs a replacement.
 */
function findSupersededDecision(
  repos: Repositories,
  input: UpdateTaskInput,
): TaskUpdateRecord | undefined {
  if (input.supersedes === undefined) {
    if (input.supersede_reason !== undefined) {
      throw new Error('supersede_reason requires supersedes.');
    }
    return undefined;
  }
  if (input.kind !== 'decision') {
    throw new Error(`supersedes applies only to decision updates, not ${input.kind}.`);
  }
  const target = repos.taskUpdates.get(input.supersedes);
  if (target?.taskId !== input.task_id) {
    throw new Error(`Decision ${String(input.supersedes)} is not recorded on ${input.task_id}.`);
  }
  if (target.kind !== 'decision') {
    throw new Error(
      `Update ${String(input.supersedes)} has kind '${target.kind}', not 'decision'.`,
    );
  }
  if (target.supersededBy !== null) {
    throw new Error(
      `Decision ${String(input.supersedes)} is already superseded by ${String(target.supersededBy)}.`,
    );
  }
  return target;
}
