import type {
  AgentRecord,
  OwnershipEventRecord,
  Repositories,
  TaskRecord,
  TaskStatus,
  ToolName,
} from '../db/index.js';
import type {
  AcceptTaskInput,
  AssignTaskInput,
  CloseTaskInput,
  ReassignTaskInput,
  ReleaseTaskInput,
  ReopenTaskInput,
} from '../domain/operations.js';
import { CLAIMED_STATUSES } from '../domain/overlap.js';
import { deriveLiveness } from '../domain/presence.js';

export interface TaskLifecycleResult {
  task: TaskRecord;
  ownershipEvent: OwnershipEventRecord;
}

interface TransitionRequest {
  task: TaskRecord;
  transition: string;
  tool: ToolName;
  actorAgentId: string;
  status: TaskStatus;
  agentId: string | null;
  assignedAgentId: string | null;
  leaseExpiresAt: string | null;
  reason: string | null;
  eventToAgentId?: string | null;
}

function registeredAgent(repos: Repositories, agentId: string): AgentRecord {
  const agent = repos.agents.get(agentId);
  if (agent === undefined) {
    throw new Error(`Agent ${agentId} is not registered. Call start_work first.`);
  }
  return agent;
}

function taskAtVersion(repos: Repositories, taskId: string, expectedVersion: number): TaskRecord {
  const task = repos.tasks.get(taskId);
  if (task === undefined) {
    throw new Error(`Task ${taskId} is not claimed.`);
  }
  if (task.version !== expectedVersion) {
    throw new Error(
      `Task ${taskId} version conflict: expected ${String(expectedVersion)}, current ${String(task.version)}.`,
    );
  }
  return task;
}

function isHumanSupervisor(actor: AgentRecord, task: TaskRecord): boolean {
  return actor.owner !== null && task.owner !== null && actor.owner === task.owner;
}

function isAgentPresent(repos: Repositories, agentId: string, now: number): boolean {
  const agent = repos.agents.get(agentId);
  if (agent === undefined) return false;
  const liveness = deriveLiveness(agent.lastSeen, now);
  return liveness === 'live' || liveness === 'idle';
}

export function hasPresentHolder(repos: Repositories, task: TaskRecord, now: number): boolean {
  if (task.agentId !== null && isAgentPresent(repos, task.agentId, now)) {
    return true;
  }
  const leaseExpired = task.leaseExpiresAt !== null && Date.parse(task.leaseExpiresAt) <= now;
  if (
    (task.status === 'assigned' || task.status === 'handoff_offered') &&
    !leaseExpired &&
    task.assignedAgentId !== null &&
    isAgentPresent(repos, task.assignedAgentId, now)
  ) {
    return true;
  }
  return false;
}

function requireOwner(task: TaskRecord, actor: AgentRecord): void {
  if (task.agentId !== actor.agentId) {
    throw new Error(
      `Agent ${actor.agentId} cannot change lifecycle for ${task.taskId}; current owner is ${task.agentId ?? 'unassigned'}.`,
    );
  }
}

function leaseDeadline(leaseSeconds: number | undefined, now: number): string | null {
  return leaseSeconds === undefined ? null : new Date(now + leaseSeconds * 1000).toISOString();
}

function applyTransition(repos: Repositories, request: TransitionRequest): TaskLifecycleResult {
  const transact = repos.db.transaction(() => {
    const updated = repos.tasks.transition({
      taskId: request.task.taskId,
      expectedVersion: request.task.version,
      status: request.status,
      agentId: request.agentId,
      assignedAgentId: request.assignedAgentId,
      leaseExpiresAt: request.leaseExpiresAt,
    });
    if (updated === undefined) {
      const current = repos.tasks.get(request.task.taskId);
      throw new Error(
        `Task ${request.task.taskId} version conflict: expected ${String(request.task.version)}, current ${String(current?.version ?? 'missing')}.`,
      );
    }
    const displacedHandoff =
      request.status === 'handoff_offered'
        ? undefined
        : repos.handoffs.pendingForTask(request.task.taskId);
    if (displacedHandoff !== undefined) {
      repos.handoffs.resolve(
        displacedHandoff.id,
        'expired',
        request.reason ?? `superseded by ${request.transition}`,
      );
    }
    const ownershipEvent = repos.ownershipEvents.record({
      taskId: request.task.taskId,
      transition: request.transition,
      actorAgentId: request.actorAgentId,
      fromAgentId: request.task.agentId,
      toAgentId:
        request.eventToAgentId === undefined
          ? (updated.agentId ?? updated.assignedAgentId)
          : request.eventToAgentId,
      fromStatus: request.task.status,
      toStatus: updated.status,
      fromVersion: request.task.version,
      toVersion: updated.version,
      reason: request.reason,
    });
    repos.events.record({
      taskId: request.task.taskId,
      tool: request.tool,
      status: 'success',
      detail: `${String(request.task.version)} -> ${String(updated.version)}`,
    });
    repos.agents.recordActivity(request.actorAgentId);
    return { task: updated, ownershipEvent };
  });
  return transact();
}

export function handleAssignTask(
  repos: Repositories,
  input: AssignTaskInput,
  now: number = Date.now(),
): TaskLifecycleResult {
  const actor = registeredAgent(repos, input.agent_id);
  registeredAgent(repos, input.to_agent_id);
  const task = taskAtVersion(repos, input.task_id, input.expected_version);
  if (task.status === 'closed' || task.status === 'complete') {
    throw new Error(`Task ${task.taskId} is ${task.status}; reopen it before assignment.`);
  }
  if (task.agentId !== null) {
    requireOwner(task, actor);
  }
  return applyTransition(repos, {
    task,
    transition: 'assign',
    tool: 'assign_task',
    actorAgentId: actor.agentId,
    status: 'assigned',
    agentId: task.agentId,
    assignedAgentId: input.to_agent_id,
    leaseExpiresAt: leaseDeadline(input.lease_seconds, now),
    reason: input.reason ?? null,
    eventToAgentId: input.to_agent_id,
  });
}

export function handleAcceptTask(
  repos: Repositories,
  input: AcceptTaskInput,
  now: number = Date.now(),
): TaskLifecycleResult {
  const actor = registeredAgent(repos, input.agent_id);
  const task = taskAtVersion(repos, input.task_id, input.expected_version);
  if (task.status !== 'assigned' || task.assignedAgentId !== actor.agentId) {
    throw new Error(`Task ${task.taskId} is not assigned to ${actor.agentId}.`);
  }
  if (task.leaseExpiresAt !== null && Date.parse(task.leaseExpiresAt) <= now) {
    return applyTransition(repos, {
      task,
      transition: 'expire_assignment',
      tool: 'expire_assignment',
      actorAgentId: actor.agentId,
      status: task.agentId === null ? 'proposed' : 'active',
      agentId: task.agentId,
      assignedAgentId: null,
      leaseExpiresAt: null,
      reason: `assignment expired at ${task.leaseExpiresAt}`,
    });
  }
  return applyTransition(repos, {
    task,
    transition: 'accept',
    tool: 'accept_task',
    actorAgentId: actor.agentId,
    status: 'active',
    agentId: actor.agentId,
    assignedAgentId: null,
    leaseExpiresAt: null,
    reason: null,
  });
}

export function handleReleaseTask(
  repos: Repositories,
  input: ReleaseTaskInput,
): TaskLifecycleResult {
  const actor = registeredAgent(repos, input.agent_id);
  const task = taskAtVersion(repos, input.task_id, input.expected_version);
  const decliningAssignment = task.status === 'assigned' && task.assignedAgentId === actor.agentId;
  if (!decliningAssignment) {
    requireOwner(task, actor);
  }
  return applyTransition(repos, {
    task,
    transition: 'release',
    tool: 'release_task',
    actorAgentId: actor.agentId,
    status: decliningAssignment && task.agentId !== null ? 'active' : 'proposed',
    agentId: decliningAssignment ? task.agentId : null,
    assignedAgentId: null,
    leaseExpiresAt: null,
    reason: input.reason ?? null,
  });
}

export function handleReassignTask(
  repos: Repositories,
  input: ReassignTaskInput,
  now: number = Date.now(),
): TaskLifecycleResult {
  const actor = registeredAgent(repos, input.agent_id);
  registeredAgent(repos, input.to_agent_id);
  const task = taskAtVersion(repos, input.task_id, input.expected_version);
  if (task.status === 'closed' || task.status === 'complete') {
    throw new Error(`Task ${task.taskId} is ${task.status}; reopen it before reassignment.`);
  }
  if (task.agentId !== actor.agentId) {
    const unfinishedClaimed = CLAIMED_STATUSES.has(task.status);
    const staleUnowned =
      task.owner === null && unfinishedClaimed && !hasPresentHolder(repos, task, now);
    const canForce = isHumanSupervisor(actor, task) || staleUnowned;
    if (input.force !== true || !canForce) {
      if (task.owner === null && !unfinishedClaimed && task.status !== 'proposed') {
        throw new Error(
          `Task ${task.taskId} is ${task.status}; only unfinished claimed work can be force-reassigned without a human owner.`,
        );
      }
      if (task.owner === null && unfinishedClaimed && !staleUnowned) {
        const holder =
          task.agentId !== null && isAgentPresent(repos, task.agentId, now)
            ? task.agentId
            : (task.assignedAgentId ?? task.agentId ?? 'unassigned');
        throw new Error(
          `Only the current owner (${holder}) can reassign ${task.taskId} while its session is still active.`,
        );
      }
      const hint =
        input.force === true ? '' : " Use transfer_work with action: 'reassign' and force: true.";
      const authority =
        task.owner === null
          ? 'a registered agent once the current owner is inactive'
          : `a registered agent for human owner ${task.owner}`;
      throw new Error(
        `Only the current owner or ${authority} can force-reassign ${task.taskId}.${hint}`,
      );
    }
  }
  return applyTransition(repos, {
    task,
    transition: input.force === true ? 'force_reassign' : 'reassign',
    tool: 'reassign_task',
    actorAgentId: actor.agentId,
    status: 'assigned',
    agentId: task.agentId,
    assignedAgentId: input.to_agent_id,
    leaseExpiresAt: leaseDeadline(input.lease_seconds, now),
    reason: input.reason,
    eventToAgentId: input.to_agent_id,
  });
}

export function handleCloseTask(repos: Repositories, input: CloseTaskInput): TaskLifecycleResult {
  const actor = registeredAgent(repos, input.agent_id);
  const task = taskAtVersion(repos, input.task_id, input.expected_version);
  requireOwner(task, actor);
  return applyTransition(repos, {
    task,
    transition: 'close',
    tool: 'close_task',
    actorAgentId: actor.agentId,
    status: input.outcome ?? 'closed',
    agentId: task.agentId,
    assignedAgentId: null,
    leaseExpiresAt: null,
    reason: input.reason,
  });
}

export function handleReopenTask(repos: Repositories, input: ReopenTaskInput): TaskLifecycleResult {
  const actor = registeredAgent(repos, input.agent_id);
  const task = taskAtVersion(repos, input.task_id, input.expected_version);
  if (!['closed', 'complete', 'handed_off', 'review_ready'].includes(task.status)) {
    throw new Error(`Task ${task.taskId} is ${task.status}, not a terminal/review state.`);
  }
  if (task.agentId !== null && task.agentId !== actor.agentId && !isHumanSupervisor(actor, task)) {
    throw new Error(`Agent ${actor.agentId} cannot reopen ${task.taskId}.`);
  }
  return applyTransition(repos, {
    task,
    transition: 'reopen',
    tool: 'reopen_task',
    actorAgentId: actor.agentId,
    status: 'active',
    agentId: actor.agentId,
    assignedAgentId: null,
    leaseExpiresAt: null,
    reason: input.reason,
  });
}
