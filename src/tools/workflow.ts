import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories, TaskRecord } from '../db/index.js';
import {
  finishWorkInputShape,
  type FinishWorkInput,
  inspectWorkInputShape,
  type InspectWorkInput,
  startWorkInputShape,
  type StartWorkInput,
  transferWorkInputShape,
  type TransferWorkInput,
  updateWorkInputShape,
  type UpdateWorkInput,
} from '../domain/schemas.js';
import { handleClaimWork, type ClaimWorkResult } from './claim-work.js';
import { handleGetTaskContext, type TaskContextResult } from './get-task-context.js';
import { handleGetWorkState } from './get-work-state.js';
import {
  handleAcceptHandoff,
  handleDeclineHandoff,
  handleOfferHandoff,
  type HandoffLifecycleResult,
} from './handoff-lifecycle.js';
import { handleHandoff, type HandoffResult } from './handoff.js';
import { handleRegisterAgent, type RegisterAgentResult } from './register-agent.js';
import {
  handleAcceptTask,
  handleAssignTask,
  handleCloseTask,
  handleReassignTask,
  handleReleaseTask,
  handleReopenTask,
  type TaskLifecycleResult,
} from './task-lifecycle.js';
import { handleUpdateTask, type UpdateTaskResult } from './update-task.js';
import {
  AgentMessageDeliveryError,
  handleSendAgentMessage,
  inspectAgentCommunication,
  type SendAgentMessageResult,
} from './agent-messages.js';
import {
  selectToolWorkspace,
  type SelectWorkspace,
  workspaceStructured,
  withWorkspaceText,
} from './workspace-routing.js';

export const PUBLIC_WORKFLOW_TOOLS = [
  'start_work',
  'inspect_work',
  'update_work',
  'transfer_work',
  'finish_work',
] as const;

export interface StartWorkResult {
  registration: RegisterAgentResult;
  claim: ClaimWorkResult;
  resumedBy: 'new_claim' | 'claim' | 'assignment' | 'handoff' | 'reopen';
}

function taskOrThrow(repos: Repositories, taskId: string): TaskRecord {
  const task = repos.tasks.get(taskId);
  if (task === undefined) {
    throw new Error(`Task ${taskId} does not exist. Call start_work first.`);
  }
  return task;
}

/**
 * Register/refresh identity and enter one owned task in a single public
 * operation. Existing assignments, addressed handoffs, proposed tasks, and
 * terminal tasks are resumed through the same proven lifecycle handlers.
 */
function startWork(repos: Repositories, input: StartWorkInput): StartWorkResult {
  const registration = handleRegisterAgent(repos, {
    agent_id: input.agent_id,
    kind: input.kind,
    owner: input.owner,
    model: input.model,
    summary: input.summary ?? input.title,
    status: 'active',
    branch: input.branch,
    worktree: input.worktree,
    cwd: input.cwd,
    pid: input.pid,
  });
  const agentId = registration.agent.agentId;
  const existing = repos.tasks.get(input.task_id);
  let resumedBy: StartWorkResult['resumedBy'] = existing === undefined ? 'new_claim' : 'claim';

  if (existing !== undefined) {
    if (existing.status === 'assigned') {
      if (existing.assignedAgentId !== agentId) {
        throw new Error(
          `Task ${existing.taskId} is assigned to ${existing.assignedAgentId ?? 'another agent'}.`,
        );
      }
      handleAcceptTask(repos, {
        task_id: existing.taskId,
        agent_id: agentId,
        expected_version: existing.version,
      });
      resumedBy = 'assignment';
    } else if (existing.status === 'handoff_offered') {
      if (existing.assignedAgentId !== agentId) {
        throw new Error(
          `Task ${existing.taskId} has a handoff pending for ${existing.assignedAgentId ?? 'another agent'}.`,
        );
      }
      const pending = repos.handoffs.pendingForTask(existing.taskId);
      if (pending === undefined) {
        throw new Error(`Task ${existing.taskId} has no pending handoff to accept.`);
      }
      handleAcceptHandoff(repos, {
        task_id: existing.taskId,
        handoff_id: pending.id,
        agent_id: agentId,
        expected_version: existing.version,
      });
      resumedBy = 'handoff';
    } else if (['closed', 'complete', 'handed_off', 'review_ready'].includes(existing.status)) {
      handleReopenTask(repos, {
        task_id: existing.taskId,
        agent_id: agentId,
        expected_version: existing.version,
        reason: 'Resumed through start_work',
      });
      resumedBy = 'reopen';
    } else if (existing.agentId === null) {
      const assigned = handleAssignTask(repos, {
        task_id: existing.taskId,
        to_agent_id: agentId,
        agent_id: agentId,
        expected_version: existing.version,
        reason: 'Accepted proposed work through start_work',
      });
      handleAcceptTask(repos, {
        task_id: existing.taskId,
        agent_id: agentId,
        expected_version: assigned.task.version,
      });
      resumedBy = 'assignment';
    }
  }

  const claim = handleClaimWork(repos, {
    task_id: input.task_id,
    title: input.title,
    owner: input.owner,
    agent: input.kind,
    agent_id: agentId,
    branch: input.branch,
    worktree: input.worktree,
    parent_task_id: input.parent_task_id,
    expected_files: input.expected_files,
    modules: input.modules,
    domains: input.domains,
    risk_tags: input.risk_tags,
    notes: input.notes,
  });

  return { registration, claim, resumedBy };
}

export function handleStartWork(repos: Repositories, input: StartWorkInput): StartWorkResult {
  const transact = repos.db.transaction(() => startWork(repos, input));
  return transact();
}

export type InspectWorkResult =
  | { scope: 'workspace'; state: ReturnType<typeof handleGetWorkState> }
  | { scope: 'task'; context: TaskContextResult }
  | { scope: 'agent'; communication: ReturnType<typeof inspectAgentCommunication> }
  | {
      scope: 'message';
      thread: ReturnType<Repositories['agentMessages']['listThread']>;
      events: ReturnType<Repositories['agentMessages']['listEvents']>;
    };

export function handleInspectWork(repos: Repositories, input: InspectWorkInput): InspectWorkResult {
  const selectors = [input.task_id, input.agent_id, input.message_id].filter(
    (value) => value !== undefined,
  );
  if (selectors.length > 1) {
    throw new Error('inspect_work accepts only one of task_id, agent_id, or message_id.');
  }
  if (input.task_id !== undefined) {
    return { scope: 'task', context: handleGetTaskContext(repos, { task_id: input.task_id }) };
  }
  if (input.agent_id !== undefined) {
    return { scope: 'agent', communication: inspectAgentCommunication(repos, input.agent_id) };
  }
  if (input.message_id !== undefined) {
    const message = repos.agentMessages.get(input.message_id);
    if (message === undefined) {
      throw new Error(`Agent message ${input.message_id} does not exist.`);
    }
    return {
      scope: 'message',
      thread: repos.agentMessages.listThread(input.message_id),
      events: repos.agentMessages.listEvents(input.message_id),
    };
  }
  return { scope: 'workspace', state: handleGetWorkState(repos) };
}

export type UpdateWorkResult = UpdateTaskResult | SendAgentMessageResult;

function updateRequired<T>(value: T | undefined, field: string, operation: string): T {
  if (value === undefined) {
    throw new Error(`${field} is required when update_work operation is ${operation}.`);
  }
  return value;
}

export function handleUpdateWork(repos: Repositories, input: UpdateWorkInput): UpdateWorkResult {
  const operation = input.operation ?? 'record';
  if (operation !== 'record') {
    return handleSendAgentMessage(repos, {
      operation,
      agentId: updateRequired(input.agent_id, 'agent_id', operation),
      toAgentId: input.to_agent_id,
      replyToMessageId: input.reply_to_message_id,
      taskId: input.task_id,
      content: input.content,
      idempotencyKey: updateRequired(input.idempotency_key, 'idempotency_key', operation),
    });
  }
  return handleUpdateTask(repos, {
    task_id: updateRequired(input.task_id, 'task_id', operation),
    kind: updateRequired(input.kind, 'kind', operation),
    content: input.content,
    agent_id: input.agent_id,
    agent: input.agent_id,
  });
}

function required<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) {
    throw new Error(`${field} is required when transfer_work action is ${action}.`);
  }
  return value;
}

function pendingHandoffId(
  repos: Repositories,
  taskId: string,
  supplied: number | undefined,
  action: string,
): number {
  return required(supplied ?? repos.handoffs.pendingForTask(taskId)?.id, 'handoff_id', action);
}

export type TransferWorkResult = TaskLifecycleResult | HandoffLifecycleResult;

export function handleTransferWork(
  repos: Repositories,
  input: TransferWorkInput,
): TransferWorkResult {
  const common = {
    task_id: input.task_id,
    agent_id: input.agent_id,
    expected_version: input.expected_version,
  };

  switch (input.action) {
    case 'assign':
      return handleAssignTask(repos, {
        ...common,
        to_agent_id: required(input.to_agent_id, 'to_agent_id', input.action),
        lease_seconds: input.lease_seconds,
        reason: input.reason,
      });
    case 'accept': {
      const task = taskOrThrow(repos, input.task_id);
      if (task.status === 'assigned') {
        return handleAcceptTask(repos, common);
      }
      if (task.status === 'handoff_offered') {
        const handoffId = pendingHandoffId(repos, input.task_id, input.handoff_id, input.action);
        return handleAcceptHandoff(repos, { ...common, handoff_id: handoffId });
      }
      throw new Error(`Task ${task.taskId} has no assignment or handoff to accept.`);
    }
    case 'decline': {
      const task = taskOrThrow(repos, input.task_id);
      if (task.status === 'assigned') {
        return handleReleaseTask(repos, { ...common, reason: input.reason });
      }
      if (task.status !== 'handoff_offered') {
        throw new Error(`Task ${task.taskId} has no assignment or handoff to decline.`);
      }
      const handoffId = pendingHandoffId(repos, input.task_id, input.handoff_id, input.action);
      return handleDeclineHandoff(repos, {
        ...common,
        handoff_id: handoffId,
        reason: required(input.reason, 'reason', input.action),
      });
    }
    case 'release':
      return handleReleaseTask(repos, { ...common, reason: input.reason });
    case 'reassign':
      return handleReassignTask(repos, {
        ...common,
        to_agent_id: required(input.to_agent_id, 'to_agent_id', input.action),
        lease_seconds: input.lease_seconds,
        reason: required(input.reason, 'reason', input.action),
        force: input.force,
      });
    case 'offer':
      return handleOfferHandoff(repos, {
        ...common,
        to_agent_id: required(input.to_agent_id, 'to_agent_id', input.action),
        what_changed: required(input.what_changed, 'what_changed', input.action),
        changed_files: input.changed_files,
        tests_run: input.tests_run,
        known_risks: input.known_risks,
        assumptions: input.assumptions,
        decisions: input.decisions,
        guardrails_checked: input.guardrails_checked,
        next_steps: input.next_steps,
        expires_seconds: input.expires_seconds,
      });
    case 'reopen':
      return handleReopenTask(repos, {
        ...common,
        reason: required(input.reason, 'reason', input.action),
      });
  }
}

export interface FinishWorkResult {
  evidence: HandoffResult;
  task: TaskRecord;
}

/** Record evidence and apply the requested review/terminal state atomically. */
export function handleFinishWork(repos: Repositories, input: FinishWorkInput): FinishWorkResult {
  const transact = repos.db.transaction(() => {
    const evidence = handleHandoff(repos, {
      task_id: input.task_id,
      status: input.outcome,
      what_changed: input.what_changed,
      changed_files: input.changed_files,
      tests_run: input.tests_run,
      known_risks: input.known_risks,
      assumptions: input.assumptions,
      decisions: input.decisions,
      guardrails_checked: input.guardrails_checked,
      needs_review_from: input.needs_review_from,
      next_steps: input.next_steps,
      ready_for_review: input.outcome === 'review_ready',
      diff_size: input.diff_size,
      open_questions: input.open_questions,
      provenance: input.provenance,
      agent_id: input.agent_id,
      expected_version: input.expected_version,
    });

    if (input.outcome === 'complete' || input.outcome === 'closed') {
      const closed = handleCloseTask(repos, {
        task_id: input.task_id,
        agent_id: input.agent_id,
        expected_version: evidence.task.version,
        reason: input.reason ?? input.what_changed,
        outcome: input.outcome,
      });
      return { evidence, task: closed.task };
    }
    return { evidence, task: evidence.task };
  });
  return transact();
}

function taskFields(task: TaskRecord): Record<string, unknown> {
  return {
    task_id: task.taskId,
    status: task.status,
    version: task.version,
    updated_at: task.updatedAt,
    agent_id: task.agentId,
    assigned_agent_id: task.assignedAgentId,
    lease_expires_at: task.leaseExpiresAt,
  };
}

function transferFields(result: TransferWorkResult): Record<string, unknown> {
  return 'handoff' in result
    ? {
        ...taskFields(result.task),
        ownership_event_id: result.ownershipEvent.id,
        handoff_id: result.handoff.id,
        delivery_status: result.handoff.deliveryStatus,
        from_agent_id: result.handoff.fromAgentId,
        to_agent_id: result.handoff.toAgentId,
      }
    : {
        ...taskFields(result.task),
        ownership_event_id: result.ownershipEvent.id,
      };
}

/** Register Concord's complete default public MCP surface. */
export function registerWorkflowTools(
  server: McpServer,
  repos: Repositories,
  onWrite?: () => void,
  selectWorkspace?: SelectWorkspace,
): void {
  server.registerTool(
    'start_work',
    {
      title: 'Start work',
      description:
        'Enter one task before editing: register or refresh this agent, accept addressed work ' +
        'when needed, claim the declared scope, and return actionable overlap warnings.',
      inputSchema: startWorkInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleStartWork(repos, args);
      onWrite?.();
      const task = result.claim.task;
      return {
        content: [
          {
            type: 'text',
            text: withWorkspaceText(
              `Started ${task.taskId}; status ${task.status}, version ${String(task.version)}, ` +
                `${String(result.claim.overlaps.length)} overlap(s).`,
              workspace,
            ),
          },
        ],
        structuredContent: {
          ...workspaceStructured(workspace),
          ...taskFields(task),
          resumed_by: result.resumedBy,
          overlaps: result.claim.overlaps.map((overlap) => ({
            task_id: overlap.taskId,
            title: overlap.title,
            reasons: overlap.reasons,
          })),
          breadth_reasons: result.claim.breadthReasons,
        },
      };
    },
  );

  server.registerTool(
    'inspect_work',
    {
      title: 'Inspect work',
      description:
        'Read the workspace, one task, one agent communication inbox/outbox, or one durable ' +
        'prompt/reply thread by supplying at most one selector.',
      inputSchema: inspectWorkInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleInspectWork(repos, args);
      if (result.scope === 'workspace') {
        return {
          content: [
            {
              type: 'text',
              text: withWorkspaceText(
                `${String(result.state.active.length)} active task(s), ` +
                  `${String(result.state.overlaps.length)} overlap(s), ` +
                  `${String(result.state.presence.length)} registered agent(s).`,
                workspace,
              ),
            },
          ],
          structuredContent: {
            ...workspaceStructured(workspace),
            scope: result.scope,
            presence: result.state.presence,
            active: result.state.active,
            overlaps: result.state.overlaps,
            stale_claims: result.state.staleClaims,
            review_ready: result.state.reviewReady,
            open_questions: result.state.openQuestions,
            communications: result.state.communications,
          },
        };
      }
      if (result.scope === 'agent') {
        return {
          content: [
            {
              type: 'text',
              text: withWorkspaceText(
                `${result.communication.agentId}; promptable ${String(result.communication.promptable)}, ` +
                  `${String(result.communication.inbox.length)} inbox message(s), ` +
                  `${String(result.communication.outbox.length)} outbox message(s).`,
                workspace,
              ),
            },
          ],
          structuredContent: {
            ...workspaceStructured(workspace),
            scope: result.scope,
            ...result.communication,
          },
        };
      }
      if (result.scope === 'message') {
        return {
          content: [
            {
              type: 'text',
              text: withWorkspaceText(
                `${String(result.thread.length)} message(s) in thread.`,
                workspace,
              ),
            },
          ],
          structuredContent: {
            ...workspaceStructured(workspace),
            scope: result.scope,
            thread: result.thread,
            events: result.events,
          },
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: withWorkspaceText(
              `${result.context.task.taskId}; status ${result.context.task.status}, ` +
                `version ${String(result.context.task.version)}, ` +
                `${String(result.context.updates.length)} update(s).`,
              workspace,
            ),
          },
        ],
        structuredContent: {
          ...workspaceStructured(workspace),
          scope: result.scope,
          task: result.context.task,
          updates: result.context.updates,
          latest_handoff: result.context.latestHandoff ?? null,
          latest_review: result.context.latestReview ?? null,
          pending_handoff: result.context.pendingHandoff ?? null,
          ownership_history: result.context.ownershipHistory,
          overlaps: result.context.overlaps,
          messages: result.context.messages,
        },
      };
    },
  );

  server.registerTool(
    'update_work',
    {
      title: 'Update work',
      description:
        'Record task context or deliver a live prompt/reply to another promptable workspace agent.',
      inputSchema: updateWorkInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      try {
        const result = handleUpdateWork(repos, args);
        onWrite?.();
        if ('update' in result) {
          return {
            content: [
              {
                type: 'text',
                text: withWorkspaceText(
                  `Recorded ${result.update.kind} for ${result.update.taskId}.`,
                  workspace,
                ),
              },
            ],
            structuredContent: {
              ...workspaceStructured(workspace),
              operation: 'record',
              update_id: result.update.id,
              task_id: result.update.taskId,
              kind: result.update.kind,
              content: result.update.content,
              agent: result.update.agent,
              created_at: result.update.createdAt,
              task_updated_at: result.task.updatedAt,
            },
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: withWorkspaceText(
                result.message.status === 'pending'
                  ? `${args.operation ?? 'prompt'} ${result.message.messageId}; queued for ` +
                      `${result.message.recipientAgentId}. ${result.outlook}`
                  : `${args.operation ?? 'prompt'} ${result.message.messageId}; status ` +
                      `${result.message.status}.`,
                workspace,
              ),
            },
          ],
          structuredContent: {
            ...workspaceStructured(workspace),
            operation: args.operation,
            message_id: result.message.messageId,
            status: result.message.status,
            sender_agent_id: result.message.senderAgentId,
            recipient_agent_id: result.message.recipientAgentId,
            reply_to_message_id: result.message.replyToMessageId,
            task_id: result.message.taskId,
            task_updated_at: result.task?.updatedAt ?? null,
            provider: result.message.provider,
            provider_receipt: result.message.providerReceipt,
            delivered_at: result.message.deliveredAt,
            idempotent_replay: result.idempotentReplay,
            outlook: result.outlook,
          },
        };
      } catch (error) {
        onWrite?.();
        if (error instanceof AgentMessageDeliveryError) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: withWorkspaceText(error.message, workspace),
              },
            ],
            structuredContent: {
              ...workspaceStructured(workspace),
              operation: args.operation,
              message_id: error.messageId || null,
              status: 'failed',
              error_code: error.code,
            },
          };
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'transfer_work',
    {
      title: 'Transfer work',
      description:
        'Apply one versioned ownership action: assign, accept, decline, release, reassign, ' +
        'offer an evidence-bearing handoff, or reopen terminal work.',
      inputSchema: transferWorkInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleTransferWork(repos, args);
      onWrite?.();
      return {
        content: [
          {
            type: 'text',
            text: withWorkspaceText(
              `${args.action} ${result.task.taskId}; status ${result.task.status}, ` +
                `version ${String(result.task.version)}.`,
              workspace,
            ),
          },
        ],
        structuredContent: {
          ...workspaceStructured(workspace),
          action: args.action,
          ...transferFields(result),
        },
      };
    },
  );

  server.registerTool(
    'finish_work',
    {
      title: 'Finish work',
      description:
        'Record completion evidence and atomically leave the task active as a handoff, mark it ' +
        'review-ready, or close it with a complete/closed outcome.',
      inputSchema: finishWorkInputShape,
    },
    (args) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const result = handleFinishWork(repos, args);
      onWrite?.();
      return {
        content: [
          {
            type: 'text',
            text: withWorkspaceText(
              `Finished ${result.task.taskId}; status ${result.task.status}, ` +
                `version ${String(result.task.version)}.`,
              workspace,
            ),
          },
        ],
        structuredContent: {
          ...workspaceStructured(workspace),
          ...taskFields(result.task),
          outcome: args.outcome,
          handoff_id: result.evidence.handoff.id,
          review_ready: result.evidence.reviewReady,
        },
      };
    },
  );
}
