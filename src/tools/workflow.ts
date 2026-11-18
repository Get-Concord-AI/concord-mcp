import { inspectWorkResponse } from './inspect-work-response.js';
import { handleInspectWork } from './inspect-work.js';
import { describeReceipt, toReceipt } from '../domain/receipts.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories, TaskRecord } from '../db/index.js';
import type { AdapterNotice } from '../adapter-check.js';
import type { AvailableUpdate } from '../update-notifier.js';
import { receiverActive } from '../domain/delivery.js';
import { harnessConfigFor } from '../domain/harness-config.js';
import {
  parseOpenCodeRequestIdentityMetadata,
  resolveActorId,
  type AgentIdentity,
  type OpenCodeRequestIdentityMetadata,
} from '../domain/identity.js';
import { liveSession } from './live-session.js';
import { recordTaskTransition, taskFlowId } from '../telemetry/task-transitions.js';
import type { TelemetryRecorder } from '../telemetry/events.js';
import type { WorkspaceContext } from '../workspaces/manager.js';
import { SocketAgentMessageDispatcher } from '../relay/socket-dispatcher.js';
import {
  finishWorkInputShape,
  type FinishWorkInput,
  inspectWorkInputShape,
  startWorkInputShape,
  type StartWorkInput,
  transferWorkInputShape,
  type TransferWorkInput,
  updateWorkInputShape,
  type UpdateWorkInput,
} from '../domain/schemas.js';
import { handleClaimWork, type ClaimWorkResult } from './claim-work.js';
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
  handleSendAgentMessageWithDelivery,
  type AgentMessageDispatcher,
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

/**
 * A tool input whose actor has already been resolved.
 *
 * `agent_id` is optional on the wire and required here: the boundary between
 * "what a model asked for" and "who Concord decided you are" is this type, and
 * the compiler will not let a handler skip it.
 */
type WithActor<T> = T & { agent_id: string };

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
function startWork(repos: Repositories, input: WithActor<StartWorkInput>): StartWorkResult {
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

export function handleStartWork(
  repos: Repositories,
  input: WithActor<StartWorkInput>,
): StartWorkResult {
  const transact = repos.db.transaction(() => startWork(repos, input));
  return transact();
}

export { handleInspectWork, type InspectWorkResult } from './inspect-work.js';

export type UpdateWorkResult = UpdateTaskResult | SendAgentMessageResult;

function updateRequired<T>(value: T | undefined, field: string, operation: string): T {
  if (value === undefined) {
    throw new Error(`${field} is required when update_work operation is ${operation}.`);
  }
  return value;
}

export function handleUpdateWork(
  repos: Repositories,
  input: WithActor<UpdateWorkInput>,
  dispatcher: AgentMessageDispatcher,
): UpdateWorkResult | Promise<UpdateWorkResult> {
  const operation = input.operation ?? 'record';
  if (
    operation !== 'record' &&
    (input.supersedes !== undefined || input.supersede_reason !== undefined)
  ) {
    throw new Error(
      `supersedes and supersede_reason work only with operation record, not ${operation}.`,
    );
  }
  if (operation === 'record' && input.expects_reply !== undefined) {
    throw new Error('expects_reply applies only to prompt and reply.');
  }
  if (operation !== 'record') {
    return handleSendAgentMessageWithDelivery(
      repos,
      {
        operation,
        agentId: input.agent_id,
        toAgentId: input.to_agent_id,
        replyToMessageId: input.reply_to_message_id,
        taskId: input.task_id,
        content: input.content,
        expectsReply: input.expects_reply,
        idempotencyKey: updateRequired(input.idempotency_key, 'idempotency_key', operation),
      },
      dispatcher,
    );
  }
  return handleUpdateTask(repos, {
    task_id: updateRequired(input.task_id, 'task_id', operation),
    kind: updateRequired(input.kind, 'kind', operation),
    content: input.content,
    agent_id: input.agent_id,
    agent: input.agent_id,
    supersedes: input.supersedes,
    supersede_reason: input.supersede_reason,
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
  input: WithActor<TransferWorkInput>,
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
export function handleFinishWork(
  repos: Repositories,
  input: WithActor<FinishWorkInput>,
): FinishWorkResult {
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
      reported_outcome: input.reported_outcome,
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
  /** Runs after each write, given the workspace a call pinned across an await. */
  onWrite?: (workspace?: WorkspaceContext) => void,
  selectWorkspace?: SelectWorkspace,
  session?: AgentIdentity,
  getAvailableUpdate?: () => AvailableUpdate | undefined,
  dispatcher: AgentMessageDispatcher = new SocketAgentMessageDispatcher(),
  telemetry?: TelemetryRecorder,
  getAdapterNotice?: () => AdapterNotice | undefined,
  requestIdentity?: (
    meta: OpenCodeRequestIdentityMetadata | undefined,
  ) => AgentIdentity | undefined,
): void {
  interface WorkflowToolResponse {
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }
  const warnedInactiveReceivers = new Set<string>();
  let updateNoticeShown = false;
  let adapterNoticeShown = false;

  /** Add one neutral recovery hint per inactive period to this MCP session. */
  const withReceiverAdvisory = <T extends WorkflowToolResponse>(
    result: T,
    callRepos: Repositories,
    meta: OpenCodeRequestIdentityMetadata | undefined,
  ): T => {
    const agentId = sessionForRequest(callRepos, meta)?.agentId;
    if (agentId === undefined) return result;
    const endpoint = callRepos.agentEndpoints.getByAgent(agentId);
    const config = endpoint === undefined ? undefined : harnessConfigFor(endpoint.provider);
    if (endpoint === undefined || config?.monitor.verified !== true || !config.monitor.background) {
      return result;
    }
    if (receiverActive(endpoint)) {
      warnedInactiveReceivers.delete(agentId);
      return result;
    }
    // Give a just-created session time to start the monitor supplied by its
    // SessionStart hook before describing the receiver as inactive.
    if (Date.now() - Date.parse(endpoint.createdAt) < 10_000) return result;
    if (warnedInactiveReceivers.has(agentId)) return result;
    warnedInactiveReceivers.add(agentId);

    const command = config.monitor.command?.replace('<agent-id>', agentId) ?? null;
    const recovery =
      command === null
        ? `Restart the ${config.monitor.kind.replaceAll('-', ' ')} for this session.`
        : `Restart it with: \`${command}\`.`;
    const text =
      "Concord's idle receiver is inactive; cause unknown. Restart unless intentionally " +
      `stopped or permission declined. ${recovery}`;
    return {
      ...result,
      content: [...result.content, { type: 'text', text }],
      structuredContent: {
        ...result.structuredContent,
        receiver_advisory: {
          status: 'inactive',
          cause: 'unknown',
          command,
        },
      },
    };
  };

  /** Surface an available release where background MCP users will actually see it. */
  const withUpdateAdvisory = <T extends WorkflowToolResponse>(result: T): T => {
    const availableUpdate = getAvailableUpdate?.();
    if (availableUpdate === undefined || updateNoticeShown) return result;
    updateNoticeShown = true;
    const text =
      `Concord update available: ${availableUpdate.currentVersion} → ` +
      `${availableUpdate.latestVersion}. Ask the user to run \`${availableUpdate.command}\` ` +
      'and restart their MCP client.';
    return {
      ...result,
      content: [...result.content, { type: 'text', text }],
      structuredContent: {
        ...result.structuredContent,
        update_available: {
          current_version: availableUpdate.currentVersion,
          latest_version: availableUpdate.latestVersion,
          command: availableUpdate.command,
        },
      },
    };
  };

  /** Once per session: this harness's adapter was missing, so say who we are and how to listen. */
  const withAdapterAdvisory = <T extends WorkflowToolResponse>(result: T): T => {
    const notice = getAdapterNotice?.();
    if (notice === undefined || adapterNoticeShown) return result;
    adapterNoticeShown = true;
    return {
      ...result,
      content: [...result.content, { type: 'text', text: notice.text }],
      structuredContent: {
        ...result.structuredContent,
        adapter_advisory: { ...notice.check, monitor_command: notice.monitorCommand },
      },
    };
  };

  const { sessionForRequest, takeDriftAdvisory } = liveSession(session, requestIdentity);

  /** Once per session: env identity and the hook-bound session diverged. */
  const withDriftAdvisory = <T extends WorkflowToolResponse>(result: T): T => {
    const advisory = takeDriftAdvisory();
    if (advisory === undefined) return result;
    const drift = { env_agent_id: advisory.envAgentId, live_agent_id: advisory.liveAgentId };
    return {
      ...result,
      content: [...result.content, { type: 'text', text: advisory.text }],
      structuredContent: { ...result.structuredContent, identity_drift: drift },
    };
  };

  const withSessionAdvisories = <T extends WorkflowToolResponse>(
    result: T,
    callRepos: Repositories = repos,
    meta: OpenCodeRequestIdentityMetadata | undefined = undefined,
  ): T =>
    withAdapterAdvisory(
      withUpdateAdvisory(withDriftAdvisory(withReceiverAdvisory(result, callRepos, meta))),
    );

  const withActor = <T extends { agent_id?: string | undefined }>(
    callRepos: Repositories,
    args: T,
    meta: OpenCodeRequestIdentityMetadata | undefined,
  ): WithActor<T> => ({
    ...args,
    agent_id: resolveActorId(sessionForRequest(callRepos, meta), args.agent_id),
  });

  server.registerTool(
    'start_work',
    {
      title: 'Start work',
      description:
        'Enter one task before editing: register or refresh this agent, accept addressed work ' +
        'when needed, claim the declared scope, and return actionable overlap warnings.',
      inputSchema: startWorkInputShape,
    },
    (args, extra) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const requestMeta = parseOpenCodeRequestIdentityMetadata(extra._meta);
      const requestSession = sessionForRequest(repos, requestMeta);
      // The session's kind wins alongside its id: the id embeds the kind, so
      // registering under a different one would describe an agent that is not
      // the one being addressed.
      const result = handleStartWork(repos, {
        ...withActor(repos, args, requestMeta),
        kind: requestSession?.kind ?? args.kind,
      });
      const startedTaskFlowId = taskFlowId(telemetry, result.claim.task.taskId);
      if (startedTaskFlowId !== undefined) {
        telemetry?.recordEvent({
          event_type: 'claim_evaluated',
          task_flow_id: startedTaskFlowId,
          claim_mode: result.resumedBy,
          checked_task_count: result.claim.checkedAgainst,
          overlap_count: result.claim.overlaps.length,
          overlap_kinds: [
            ...new Set(result.claim.overlaps.flatMap((overlap) => overlap.kinds)),
          ].sort(),
          breadth_warning_count: result.claim.breadthReasons.length,
        });
      }
      onWrite?.(workspace);
      const task = result.claim.task;
      return withSessionAdvisories({
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
      }, repos, requestMeta);
    },
  );

  server.registerTool(
    'inspect_work',
    {
      title: 'Inspect work',
      description:
        'Read the workspace, one task, one agent communication inbox/outbox, or one durable ' +
        'prompt/reply thread by supplying at most one selector. query searches past messages, ' +
        'findings, decisions and handoffs; search before asking a peer what was already found.',
      inputSchema: inspectWorkInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args, extra) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const requestMeta = parseOpenCodeRequestIdentityMetadata(extra._meta);
      const result = handleInspectWork(repos, args, sessionForRequest(repos, requestMeta)?.agentId);
      return withSessionAdvisories(
        inspectWorkResponse(result, workspace),
        repos,
        requestMeta,
      );
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
    async (args, extra) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const requestMeta = parseOpenCodeRequestIdentityMetadata(extra._meta);
      // Delivery awaits, and the client's folder may become the active workspace meanwhile:
      // the whole call stays with the workspace it started in.
      const callRepos = workspace?.repos ?? repos;
      const withCallAdvisories = <T extends WorkflowToolResponse>(result: T): T =>
        withSessionAdvisories(result, callRepos, requestMeta);
      const telemetryWorkspaceRoot = workspace?.repoRoot;
      const messageTaskId =
        args.task_id ??
        (args.operation === 'reply' && args.reply_to_message_id !== undefined
          ? callRepos.agentMessages.get(args.reply_to_message_id)?.taskId
          : undefined);
      const messageTaskFlowId =
        messageTaskId === undefined || messageTaskId === null
          ? null
          : (taskFlowId(telemetry, messageTaskId) ?? null);
      try {
        const result = await handleUpdateWork(
          callRepos,
          withActor(callRepos, args, requestMeta),
          dispatcher,
        );
        onWrite?.(workspace);
        if ('update' in result) {
          return withCallAdvisories({
            content: [
              {
                type: 'text',
                text: withWorkspaceText(
                  `Recorded ${result.update.kind} #${String(result.update.id)} for ${result.update.taskId}` +
                    (args.supersedes === undefined
                      ? '.'
                      : ` (supersedes #${String(args.supersedes)}).`),
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
          });
        }
        if (!result.idempotentReplay || result.immediateMode !== null) {
          telemetry?.recordEvent(
            {
              event_type: 'message_delivery',
              task_flow_id: messageTaskFlowId,
              message_kind: args.operation === 'reply' ? 'reply' : 'prompt',
              stage: 'send',
              result: result.delivery === 'delivered' ? 'delivered' : 'queued',
              delivery_mode: result.immediateMode,
              error_code: null,
              latency_ms:
                result.message.deliveredAt === null
                  ? null
                  : Math.max(
                      0,
                      Date.parse(result.message.deliveredAt) - Date.parse(result.message.createdAt),
                    ),
            },
            telemetryWorkspaceRoot,
          );
        }
        return withCallAdvisories({
          content: [
            {
              type: 'text',
              text: withWorkspaceText(
                `${args.operation ?? 'prompt'} ${result.message.messageId} to ` +
                  `${result.message.recipientAgentId}: ` +
                  `${describeReceipt(toReceipt(result.message))}. ${result.outlook}`,
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
            expects_reply: result.message.expectsReply,
            task_id: result.message.taskId,
            task_updated_at: result.task?.updatedAt ?? null,
            provider: result.message.provider,
            provider_receipt: result.message.providerReceipt,
            delivered_at: result.message.deliveredAt,
            receipt: toReceipt(result.message),
            idempotent_replay: result.idempotentReplay,
            delivery: result.delivery,
            immediate_mode: result.immediateMode,
            outlook: result.outlook,
          },
        });
      } catch (error) {
        onWrite?.(workspace);
        if (error instanceof AgentMessageDeliveryError) {
          telemetry?.recordEvent(
            {
              event_type: 'message_delivery',
              task_flow_id: messageTaskFlowId,
              message_kind: args.operation === 'reply' ? 'reply' : 'prompt',
              stage: 'send',
              result: 'failed',
              delivery_mode: null,
              error_code: error.code,
              latency_ms: null,
            },
            telemetryWorkspaceRoot,
          );
          return withCallAdvisories({
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
          });
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
    (args, extra) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const requestMeta = parseOpenCodeRequestIdentityMetadata(extra._meta);
      const result = handleTransferWork(repos, withActor(repos, args, requestMeta));
      recordTaskTransition(telemetry, result.task.taskId, args.action, result.task.status);
      onWrite?.(workspace);
      return withSessionAdvisories({
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
      }, repos, requestMeta);
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
    (args, extra) => {
      const workspace = selectToolWorkspace(selectWorkspace, args.workspace_id);
      const requestMeta = parseOpenCodeRequestIdentityMetadata(extra._meta);
      const result = handleFinishWork(repos, withActor(repos, args, requestMeta));
      const finishedTaskFlowId = taskFlowId(telemetry, result.task.taskId);
      if (finishedTaskFlowId !== undefined) {
        telemetry?.recordEvent({
          event_type: 'task_lifecycle',
          task_flow_id: finishedTaskFlowId,
          transition: 'finish',
          status: result.task.status,
          elapsed_ms: Math.max(0, Date.now() - Date.parse(result.task.createdAt)),
        });
        if (args.reported_outcome !== undefined) {
          telemetry?.recordEvent({
            event_type: 'reported_outcome',
            task_flow_id: finishedTaskFlowId,
            source: args.reported_outcome.source,
            acceptance: args.reported_outcome.acceptance,
            integration: args.reported_outcome.integration,
            human_intervention_ms: args.reported_outcome.human_intervention_ms ?? null,
            rework_ms: args.reported_outcome.rework_ms ?? null,
          });
        }
      }
      onWrite?.(workspace);
      return withSessionAdvisories({
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
      }, repos, requestMeta);
    },
  );
}
