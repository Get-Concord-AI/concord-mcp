import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type {
  AgentRecord,
  OwnershipEventRecord,
  Repositories,
  TaskRecord,
  TaskStatus,
  ToolName,
} from '../db/index.js';
import {
  acceptTaskInputShape,
  type AcceptTaskInput,
  assignTaskInputShape,
  type AssignTaskInput,
  closeTaskInputShape,
  type CloseTaskInput,
  reassignTaskInputShape,
  type ReassignTaskInput,
  releaseTaskInputShape,
  type ReleaseTaskInput,
  reopenTaskInputShape,
  type ReopenTaskInput,
} from '../domain/schemas.js';
import {
  selectToolWorkspace,
  type SelectWorkspace,
  workspaceStructured,
  withWorkspaceText,
} from './workspace-routing.js';

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
    throw new Error(`Agent ${agentId} is not registered. Call register_agent first.`);
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
    repos.agents.touch(request.actorAgentId);
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
  if (task.agentId !== actor.agentId) {
    if (input.force !== true || !isHumanSupervisor(actor, task)) {
      throw new Error(
        `Only the current owner or a registered agent for human owner ${task.owner ?? '(none)'} can force-reassign ${task.taskId}.`,
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

function lifecycleText(action: string, result: TaskLifecycleResult): string {
  return `${action} ${result.task.taskId}; status ${result.task.status}, version ${String(result.task.version)}.`;
}

function lifecycleStructured(result: TaskLifecycleResult): Record<string, unknown> {
  return {
    task_id: result.task.taskId,
    status: result.task.status,
    version: result.task.version,
    agent_id: result.task.agentId,
    assigned_agent_id: result.task.assignedAgentId,
    lease_expires_at: result.task.leaseExpiresAt,
    ownership_event_id: result.ownershipEvent.id,
  };
}

export function registerTaskLifecycle(
  server: McpServer,
  repos: Repositories,
  onWrite?: () => void,
  selectWorkspace?: SelectWorkspace,
): void {
  server.registerTool(
    'assign_task',
    {
      title: 'Assign task',
      description:
        'Offer an existing task to a registered agent. Assignment does not mean acceptance or active work.',
      inputSchema: assignTaskInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleAssignTask(repos, args);
      onWrite?.();
      return {
        content: [
          { type: 'text', text: withWorkspaceText(lifecycleText('Assigned', result), workspace) },
        ],
        structuredContent: { ...workspaceStructured(workspace), ...lifecycleStructured(result) },
      };
    },
  );
  server.registerTool(
    'accept_task',
    {
      title: 'Accept task',
      description:
        'Accept a live assignment using its current task version and become active owner.',
      inputSchema: acceptTaskInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleAcceptTask(repos, args);
      onWrite?.();
      const action =
        result.ownershipEvent.transition === 'expire_assignment'
          ? 'Expired assignment for'
          : 'Accepted';
      return {
        content: [
          { type: 'text', text: withWorkspaceText(lifecycleText(action, result), workspace) },
        ],
        structuredContent: { ...workspaceStructured(workspace), ...lifecycleStructured(result) },
      };
    },
  );
  server.registerTool(
    'release_task',
    {
      title: 'Release task',
      description: 'Release a task owned by this registered agent back to proposed/unassigned.',
      inputSchema: releaseTaskInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleReleaseTask(repos, args);
      onWrite?.();
      return {
        content: [
          { type: 'text', text: withWorkspaceText(lifecycleText('Released', result), workspace) },
        ],
        structuredContent: { ...workspaceStructured(workspace), ...lifecycleStructured(result) },
      };
    },
  );
  server.registerTool(
    'reassign_task',
    {
      title: 'Reassign task',
      description:
        'Reassign owned work with an audited reason. Non-owner force requires a registered agent for the same human owner.',
      inputSchema: reassignTaskInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleReassignTask(repos, args);
      onWrite?.();
      return {
        content: [
          { type: 'text', text: withWorkspaceText(lifecycleText('Reassigned', result), workspace) },
        ],
        structuredContent: { ...workspaceStructured(workspace), ...lifecycleStructured(result) },
      };
    },
  );
  server.registerTool(
    'close_task',
    {
      title: 'Close task',
      description: 'Close owned work with an audited reason and expected task version.',
      inputSchema: closeTaskInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleCloseTask(repos, args);
      onWrite?.();
      return {
        content: [
          { type: 'text', text: withWorkspaceText(lifecycleText('Closed', result), workspace) },
        ],
        structuredContent: { ...workspaceStructured(workspace), ...lifecycleStructured(result) },
      };
    },
  );
  server.registerTool(
    'reopen_task',
    {
      title: 'Reopen task',
      description:
        'Reopen terminal, legacy handed-off, or review-ready work with an audited reason.',
      inputSchema: reopenTaskInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleReopenTask(repos, args);
      onWrite?.();
      return {
        content: [
          { type: 'text', text: withWorkspaceText(lifecycleText('Reopened', result), workspace) },
        ],
        structuredContent: { ...workspaceStructured(workspace), ...lifecycleStructured(result) },
      };
    },
  );
}
