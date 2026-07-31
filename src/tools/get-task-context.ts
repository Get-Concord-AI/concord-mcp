import type {
  HandoffRecord,
  OwnershipEventRecord,
  Repositories,
  ReviewRecord,
  TaskRecord,
  TaskUpdateRecord,
  AgentMessageRecord,
} from '../db/index.js';
import type { GetTaskContextInput } from '../domain/operations.js';
import { detectOverlaps, type OverlapWarning } from '../domain/overlap.js';

export interface TaskContextResult {
  task: TaskRecord;
  updates: TaskUpdateRecord[];
  latestHandoff: HandoffRecord | undefined;
  latestReview: ReviewRecord | undefined;
  overlaps: OverlapWarning[];
  pendingHandoff: HandoffRecord | undefined;
  ownershipHistory: OwnershipEventRecord[];
  messages: AgentMessageRecord[];
}

export function handleGetTaskContext(
  repos: Repositories,
  input: GetTaskContextInput,
): TaskContextResult {
  const task = repos.tasks.get(input.task_id);
  if (!task) {
    throw new Error(`Task "${input.task_id}" is not claimed. Call start_work first.`);
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
    pendingHandoff: repos.handoffs.pendingForTask(task.taskId),
    ownershipHistory: repos.ownershipEvents.listByTask(task.taskId),
    messages: repos.agentMessages.listByTask(task.taskId),
  };
}
