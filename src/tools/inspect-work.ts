import type { Repositories } from '../db/index.js';
import type { InspectWorkInput } from '../domain/schemas.js';
import { handleGetTaskContext, type TaskContextResult } from './get-task-context.js';
import { handleGetWorkState } from './get-work-state.js';
import {
  inspectAgentInbox,
  inspectThread,
  visibleTaskMessages,
  type AgentInboxView,
  type ThreadView,
} from './inspect-messages.js';

export type InspectWorkResult =
  | { scope: 'workspace'; state: ReturnType<typeof handleGetWorkState> }
  | { scope: 'task'; context: TaskContextResult }
  | { scope: 'agent'; communication: AgentInboxView }
  | ({ scope: 'message' } & ThreadView);

/**
 * `viewer` is who is asking: the session's own agent, or, where Concord cannot
 * see the session, the agent the caller names. Message content is shown only
 * to its sender and recipient. With `message_id` or `task_id`, `agent_id`
 * names the viewer rather than an inbox to inspect.
 */
export function handleInspectWork(
  repos: Repositories,
  input: InspectWorkInput,
  sessionAgentId?: string,
): InspectWorkResult {
  const scoped = [input.task_id, input.message_id].filter((value) => value !== undefined);
  if (scoped.length > 1) {
    throw new Error('inspect_work accepts only one of task_id, agent_id, or message_id.');
  }
  const viewer = sessionAgentId ?? input.agent_id;
  if (input.task_id !== undefined) {
    const context = handleGetTaskContext(repos, { task_id: input.task_id });
    return {
      scope: 'task',
      context: { ...context, messages: visibleTaskMessages(repos, context.messages, viewer) },
    };
  }
  if (input.message_id !== undefined) {
    return { scope: 'message', ...inspectThread(repos, input.message_id, viewer) };
  }
  if (input.agent_id !== undefined) {
    return {
      scope: 'agent',
      communication: inspectAgentInbox(repos, input.agent_id, sessionAgentId),
    };
  }
  return { scope: 'workspace', state: handleGetWorkState(repos) };
}

