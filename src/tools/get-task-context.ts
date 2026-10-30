import { deriveLiveness, type Liveness } from '../domain/presence.js';
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
  ownerLiveness: Liveness | 'unregistered' | null;
  updates: TaskUpdateRecord[];
  latestHandoff: HandoffRecord | undefined;
  latestReview: ReviewRecord | undefined;
  overlaps: OverlapWarning[];
  pendingHandoff: HandoffRecord | undefined;
  ownershipHistory: OwnershipEventRecord[];
  messages: AgentMessageRecord[];
}

/** Superseded decisions stay in the log but are hidden unless the caller asks for them. */
function visibleUpdates(
  updates: TaskUpdateRecord[],
  includeSuperseded: boolean,
): TaskUpdateRecord[] {
  return includeSuperseded ? updates : updates.filter((update) => update.supersededBy === null);
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
    ownerLiveness:
      task.agentId === null
        ? null
        : (() => {
            const owner = repos.agents.get(task.agentId);
            return owner === undefined
              ? 'unregistered'
              : deriveLiveness(owner.lastSeen, Date.now());
          })(),
    updates: visibleUpdates(
      repos.taskUpdates.listByTask(task.taskId),
      input.include_superseded === true,
    ),
    latestHandoff: repos.handoffs.latestForTask(task.taskId),
    latestReview: repos.reviews.latestForTask(task.taskId),
    overlaps,
    pendingHandoff: repos.handoffs.pendingForTask(task.taskId),
    ownershipHistory: repos.ownershipEvents.listByTask(task.taskId),
    messages: repos.agentMessages.listByTask(task.taskId),
  };
}
