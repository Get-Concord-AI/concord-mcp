import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type {
  HandoffDeliveryStatus,
  HandoffRecord,
  OwnershipEventRecord,
  Repositories,
  TaskRecord,
} from '../db/index.js';
import {
  acceptHandoffInputShape,
  type AcceptHandoffInput,
  declineHandoffInputShape,
  type DeclineHandoffInput,
  offerHandoffInputShape,
  type OfferHandoffInput,
} from '../domain/schemas.js';
import {
  selectToolWorkspace,
  type SelectWorkspace,
  workspaceStructured,
  withWorkspaceText,
} from './workspace-routing.js';

export interface HandoffLifecycleResult {
  task: TaskRecord;
  handoff: HandoffRecord;
  ownershipEvent: OwnershipEventRecord;
}

function requireRegistered(repos: Repositories, agentId: string): void {
  if (repos.agents.get(agentId) === undefined) {
    throw new Error(`Agent ${agentId} is not registered. Call register_agent first.`);
  }
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

function pendingHandoff(repos: Repositories, taskId: string, handoffId: number): HandoffRecord {
  const handoff = repos.handoffs.get(handoffId);
  if (handoff?.taskId !== taskId || handoff.deliveryStatus !== 'pending') {
    throw new Error(`Pending handoff ${String(handoffId)} for ${taskId} was not found.`);
  }
  return handoff;
}

function recordOwnership(
  repos: Repositories,
  before: TaskRecord,
  after: TaskRecord,
  transition: string,
  actorAgentId: string,
  toAgentId: string | null,
  reason: string | null,
): OwnershipEventRecord {
  return repos.ownershipEvents.record({
    taskId: before.taskId,
    transition,
    actorAgentId,
    fromAgentId: before.agentId,
    toAgentId,
    fromStatus: before.status,
    toStatus: after.status,
    fromVersion: before.version,
    toVersion: after.version,
    reason,
  });
}

export function handleOfferHandoff(
  repos: Repositories,
  input: OfferHandoffInput,
  now: number = Date.now(),
): HandoffLifecycleResult {
  requireRegistered(repos, input.agent_id);
  requireRegistered(repos, input.to_agent_id);
  const task = taskAtVersion(repos, input.task_id, input.expected_version);
  if (task.agentId !== input.agent_id) {
    throw new Error(
      `Agent ${input.agent_id} cannot offer ${task.taskId}; current owner is ${task.agentId ?? 'unassigned'}.`,
    );
  }
  if (task.status !== 'active' && task.status !== 'blocked') {
    throw new Error(
      `Task ${task.taskId} is ${task.status}; only active or blocked work can be offered.`,
    );
  }
  if (repos.handoffs.pendingForTask(task.taskId) !== undefined) {
    throw new Error(`Task ${task.taskId} already has a pending handoff.`);
  }
  const expiresAt =
    input.expires_seconds === undefined
      ? null
      : new Date(now + input.expires_seconds * 1000).toISOString();

  const transact = repos.db.transaction(() => {
    const updated = repos.tasks.transition({
      taskId: task.taskId,
      expectedVersion: task.version,
      status: 'handoff_offered',
      agentId: task.agentId,
      assignedAgentId: input.to_agent_id,
      leaseExpiresAt: expiresAt,
    });
    if (updated === undefined) {
      throw new Error(`Task ${task.taskId} changed while the handoff was being offered.`);
    }
    const handoff = repos.handoffs.create({
      taskId: task.taskId,
      status: 'in_progress',
      changedFiles: input.changed_files ?? [],
      whatChanged: input.what_changed,
      testsRun: input.tests_run ?? [],
      knownRisks: input.known_risks ?? [],
      assumptions: input.assumptions ?? [],
      decisions: input.decisions ?? [],
      guardrailsChecked: input.guardrails_checked ?? [],
      needsReviewFrom: [],
      nextSteps: input.next_steps ?? [],
      fromAgentId: input.agent_id,
      toAgentId: input.to_agent_id,
      deliveryStatus: 'pending',
      expiresAt,
      taskVersion: updated.version,
    });
    const ownershipEvent = recordOwnership(
      repos,
      task,
      updated,
      'offer_handoff',
      input.agent_id,
      input.to_agent_id,
      null,
    );
    repos.events.record({
      taskId: task.taskId,
      tool: 'offer_handoff',
      status: 'success',
      detail: `handoff ${String(handoff.id)} to ${input.to_agent_id}`,
    });
    repos.agents.touch(input.agent_id);
    return { task: updated, handoff, ownershipEvent };
  });
  return transact();
}

function resolveHandoff(
  repos: Repositories,
  task: TaskRecord,
  handoff: HandoffRecord,
  actorAgentId: string,
  deliveryStatus: Exclude<HandoffDeliveryStatus, 'recorded' | 'pending'>,
  newOwner: string,
  transition: 'accept_handoff' | 'decline_handoff' | 'expire_handoff',
  reason: string | null,
): HandoffLifecycleResult {
  const transact = repos.db.transaction(() => {
    const updated = repos.tasks.transition({
      taskId: task.taskId,
      expectedVersion: task.version,
      status: 'active',
      agentId: newOwner,
      assignedAgentId: null,
      leaseExpiresAt: null,
    });
    if (updated === undefined) {
      throw new Error(`Task ${task.taskId} changed while handoff ${String(handoff.id)} resolved.`);
    }
    const resolved = repos.handoffs.resolve(handoff.id, deliveryStatus, reason);
    if (resolved === undefined) {
      throw new Error(`Handoff ${String(handoff.id)} was already resolved.`);
    }
    const ownershipEvent = recordOwnership(
      repos,
      task,
      updated,
      transition,
      actorAgentId,
      newOwner,
      reason,
    );
    repos.events.record({
      taskId: task.taskId,
      tool: transition,
      status: 'success',
      detail: `handoff ${String(handoff.id)} ${deliveryStatus}`,
    });
    repos.agents.touch(actorAgentId);
    return { task: updated, handoff: resolved, ownershipEvent };
  });
  return transact();
}

function expireHandoff(
  repos: Repositories,
  task: TaskRecord,
  handoff: HandoffRecord,
  actorAgentId: string,
): HandoffLifecycleResult {
  return resolveHandoff(
    repos,
    task,
    handoff,
    actorAgentId,
    'expired',
    handoff.fromAgentId ?? task.agentId ?? '',
    'expire_handoff',
    'handoff expired',
  );
}

export function handleAcceptHandoff(
  repos: Repositories,
  input: AcceptHandoffInput,
  now: number = Date.now(),
): HandoffLifecycleResult {
  requireRegistered(repos, input.agent_id);
  const task = taskAtVersion(repos, input.task_id, input.expected_version);
  const handoff = pendingHandoff(repos, input.task_id, input.handoff_id);
  if (handoff.toAgentId !== input.agent_id) {
    throw new Error(`Handoff ${String(handoff.id)} is not addressed to ${input.agent_id}.`);
  }
  if (handoff.expiresAt !== null && Date.parse(handoff.expiresAt) <= now) {
    return expireHandoff(repos, task, handoff, input.agent_id);
  }
  return resolveHandoff(
    repos,
    task,
    handoff,
    input.agent_id,
    'accepted',
    input.agent_id,
    'accept_handoff',
    null,
  );
}

export function handleDeclineHandoff(
  repos: Repositories,
  input: DeclineHandoffInput,
): HandoffLifecycleResult {
  requireRegistered(repos, input.agent_id);
  const task = taskAtVersion(repos, input.task_id, input.expected_version);
  const handoff = pendingHandoff(repos, input.task_id, input.handoff_id);
  if (handoff.toAgentId !== input.agent_id) {
    throw new Error(`Handoff ${String(handoff.id)} is not addressed to ${input.agent_id}.`);
  }
  if (handoff.fromAgentId === null) {
    throw new Error(`Handoff ${String(handoff.id)} has no recorded sender.`);
  }
  return resolveHandoff(
    repos,
    task,
    handoff,
    input.agent_id,
    'declined',
    handoff.fromAgentId,
    'decline_handoff',
    input.reason,
  );
}

function handoffText(action: string, result: HandoffLifecycleResult): string {
  return `${action} handoff ${String(result.handoff.id)} for ${result.task.taskId}; status ${result.task.status}, version ${String(result.task.version)}.`;
}

function handoffStructured(result: HandoffLifecycleResult): Record<string, unknown> {
  return {
    task_id: result.task.taskId,
    task_status: result.task.status,
    version: result.task.version,
    agent_id: result.task.agentId,
    assigned_agent_id: result.task.assignedAgentId,
    handoff_id: result.handoff.id,
    delivery_status: result.handoff.deliveryStatus,
    from_agent_id: result.handoff.fromAgentId,
    to_agent_id: result.handoff.toAgentId,
    expires_at: result.handoff.expiresAt,
    ownership_event_id: result.ownershipEvent.id,
  };
}

export function registerHandoffLifecycle(
  server: McpServer,
  repos: Repositories,
  onWrite?: () => void,
  selectWorkspace?: SelectWorkspace,
): void {
  server.registerTool(
    'offer_handoff',
    {
      title: 'Offer handoff',
      description:
        'Offer owned active/blocked work to a registered recipient with evidence. Ownership stays with the sender until acceptance.',
      inputSchema: offerHandoffInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleOfferHandoff(repos, args);
      onWrite?.();
      return {
        content: [
          { type: 'text', text: withWorkspaceText(handoffText('Offered', result), workspace) },
        ],
        structuredContent: { ...workspaceStructured(workspace), ...handoffStructured(result) },
      };
    },
  );
  server.registerTool(
    'accept_handoff',
    {
      title: 'Accept handoff',
      description:
        'Accept a pending handoff addressed to this registered agent and atomically become owner.',
      inputSchema: acceptHandoffInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleAcceptHandoff(repos, args);
      onWrite?.();
      const action = result.handoff.deliveryStatus === 'expired' ? 'Expired' : 'Accepted';
      return {
        content: [
          { type: 'text', text: withWorkspaceText(handoffText(action, result), workspace) },
        ],
        structuredContent: { ...workspaceStructured(workspace), ...handoffStructured(result) },
      };
    },
  );
  server.registerTool(
    'decline_handoff',
    {
      title: 'Decline handoff',
      description:
        'Decline a pending handoff addressed to this registered agent and return it to the sender.',
      inputSchema: declineHandoffInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleDeclineHandoff(repos, args);
      onWrite?.();
      return {
        content: [
          { type: 'text', text: withWorkspaceText(handoffText('Declined', result), workspace) },
        ],
        structuredContent: { ...workspaceStructured(workspace), ...handoffStructured(result) },
      };
    },
  );
}
