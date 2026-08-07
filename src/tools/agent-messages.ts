import { randomUUID } from 'node:crypto';

import type {
  AgentEndpointRecord,
  AgentMessageErrorCode,
  AgentMessageRecord,
  Repositories,
  TaskRecord,
} from '../db/index.js';
import { deliveryOutlook, transports } from '../domain/delivery.js';

export class AgentMessageDeliveryError extends Error {
  constructor(
    readonly code: AgentMessageErrorCode,
    readonly messageId: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentMessageDeliveryError';
  }
}

export interface SendAgentMessageInput {
  operation: 'prompt' | 'reply';
  agentId: string;
  toAgentId?: string | undefined;
  replyToMessageId?: string | undefined;
  taskId?: string | undefined;
  content: string;
  idempotencyKey: string;
}

export interface SendAgentMessageResult {
  message: AgentMessageRecord;
  idempotentReplay: boolean;
  task: TaskRecord | null;
  /** What the sender should expect about when the recipient will see this. */
  outlook: string;
}

/**
 * Whether a registered endpoint can still take a message. A lease that has run
 * out means the session is gone; queueing for it would strand the message.
 */
export function endpointPromptable(
  endpoint: AgentEndpointRecord | undefined,
  now = Date.now(),
): boolean {
  return (
    endpoint?.status === 'connected' &&
    transports.some((transport) => endpoint.capabilities.includes(transport)) &&
    (endpoint.expiresAt === null || Date.parse(endpoint.expiresAt) > now)
  );
}

function required(value: string | undefined, field: string, operation: string): string {
  if (value === undefined) {
    throw new Error(`${field} is required when update_work operation is ${operation}.`);
  }
  return value;
}

function fail(
  repos: Repositories,
  message: AgentMessageRecord,
  code: AgentMessageErrorCode,
  detail: string,
): never {
  repos.agentMessages.markFailed(message.messageId, code, detail);
  throw new AgentMessageDeliveryError(code, message.messageId, detail);
}

export function handleSendAgentMessage(
  repos: Repositories,
  input: SendAgentMessageInput,
): SendAgentMessageResult {
  const sender = repos.agents.get(input.agentId);
  if (sender === undefined) {
    throw new AgentMessageDeliveryError(
      'unauthorized',
      '',
      `Agent ${input.agentId} is not registered.`,
    );
  }

  const parent =
    input.operation === 'reply'
      ? repos.agentMessages.get(
          required(input.replyToMessageId, 'reply_to_message_id', input.operation),
        )
      : undefined;
  if (input.operation === 'reply' && parent === undefined) {
    throw new AgentMessageDeliveryError(
      'unauthorized',
      input.replyToMessageId ?? '',
      `Message ${input.replyToMessageId ?? '(missing)'} does not exist.`,
    );
  }
  if (parent !== undefined && parent.recipientAgentId !== input.agentId) {
    throw new AgentMessageDeliveryError(
      'unauthorized',
      parent.messageId,
      `Agent ${input.agentId} is not the recipient of ${parent.messageId}.`,
    );
  }
  if (parent?.status === 'failed' || parent?.status === 'pending') {
    throw new AgentMessageDeliveryError(
      'unauthorized',
      parent.messageId,
      `Message ${parent.messageId} was not delivered and cannot be replied to.`,
    );
  }
  if (parent !== undefined && input.taskId !== undefined && input.taskId !== parent.taskId) {
    throw new AgentMessageDeliveryError(
      'unauthorized',
      parent.messageId,
      `Reply task ${input.taskId} does not match the original message context.`,
    );
  }

  const recipientAgentId =
    parent?.senderAgentId ?? required(input.toAgentId, 'to_agent_id', input.operation);
  if (recipientAgentId === input.agentId) {
    throw new AgentMessageDeliveryError('unauthorized', '', 'An agent cannot prompt itself.');
  }
  if (repos.agents.get(recipientAgentId) === undefined) {
    throw new AgentMessageDeliveryError(
      'target_unreachable',
      '',
      `Agent ${recipientAgentId} is not registered in this workspace.`,
    );
  }
  if (input.taskId !== undefined && repos.tasks.get(input.taskId) === undefined) {
    throw new Error(`Task ${input.taskId} does not exist.`);
  }
  const contextualTaskId = input.taskId ?? parent?.taskId ?? null;
  const task = contextualTaskId === null ? undefined : repos.tasks.get(contextualTaskId);

  const replay = repos.agentMessages.getByIdempotency(input.agentId, input.idempotencyKey);
  let message: AgentMessageRecord;
  let idempotentReplay = false;
  if (replay !== undefined) {
    if (
      replay.recipientAgentId !== recipientAgentId ||
      replay.content !== input.content ||
      replay.replyToMessageId !== (parent?.messageId ?? null)
    ) {
      throw new AgentMessageDeliveryError(
        'unauthorized',
        replay.messageId,
        'idempotency_key was already used for a different message.',
      );
    }
    if (replay.status === 'failed') {
      throw new AgentMessageDeliveryError(
        replay.errorCode ?? 'target_unreachable',
        replay.messageId,
        replay.errorDetail ?? `Message ${replay.messageId} previously failed delivery.`,
      );
    }
    if (replay.status !== 'pending') {
      const known = repos.agentEndpoints.getByAgent(recipientAgentId);
      return {
        message: replay,
        idempotentReplay: true,
        task: task ?? null,
        outlook: deliveryOutlook(known?.capabilities ?? []),
      };
    }
    message = replay;
    idempotentReplay = true;
  } else {
    message = repos.agentMessages.create({
      messageId: randomUUID(),
      taskId: contextualTaskId,
      senderAgentId: input.agentId,
      recipientAgentId,
      replyToMessageId: parent?.messageId ?? null,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
    });
  }
  const endpoint = repos.agentEndpoints.getByAgent(recipientAgentId);
  if (endpoint === undefined) {
    fail(
      repos,
      message,
      'target_not_promptable',
      `Agent ${recipientAgentId} has no prompt endpoint.`,
    );
  }
  if (!endpointPromptable(endpoint)) {
    fail(
      repos,
      message,
      'target_unreachable',
      `Agent ${recipientAgentId} is registered but its session is no longer live.`,
    );
  }

  // The pending row is the queue. Delivery is recorded when the recipient
  // actually reads it, so `delivered` never overstates what the agent has seen.
  if (parent !== undefined) {
    repos.agentMessages.markReplied(parent.messageId);
  }
  repos.agents.touch(input.agentId);
  const activityTask =
    !idempotentReplay && task !== undefined ? repos.tasks.touchActivity(task.taskId) : task;
  return {
    message,
    idempotentReplay,
    task: activityTask ?? null,
    outlook: deliveryOutlook(endpoint.capabilities),
  };
}

export interface AgentCommunicationView {
  agentId: string;
  promptable: boolean;
  provider: string | null;
  capabilities: string[];
  inbox: AgentMessageRecord[];
  outbox: AgentMessageRecord[];
}

export function inspectAgentCommunication(
  repos: Repositories,
  agentId: string,
): AgentCommunicationView {
  if (repos.agents.get(agentId) === undefined) {
    throw new Error(`Agent ${agentId} is not registered.`);
  }
  const endpoint = repos.agentEndpoints.getByAgent(agentId);
  const messages = repos.agentMessages.listByAgent(agentId);
  return {
    agentId,
    promptable: endpointPromptable(endpoint),
    provider: endpoint?.provider ?? null,
    capabilities: endpoint?.capabilities ?? [],
    inbox: messages.filter((message) => message.recipientAgentId === agentId),
    outbox: messages.filter((message) => message.senderAgentId === agentId),
  };
}
