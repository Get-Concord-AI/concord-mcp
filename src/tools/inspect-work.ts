import type { Repositories } from '../db/index.js';
import type { InspectWorkInput } from '../domain/schemas.js';
import { handleGetTaskContext, type TaskContextResult } from './get-task-context.js';
import { handleGetWorkState } from './get-work-state.js';
import {
  inspectAgentInbox,
  inspectThread,
  visibleTaskMessages,
  type AgentInboxInspection,
  type ThreadView,
  type Viewer,
} from './inspect-messages.js';
import { searchWork, type SearchView } from './search-work.js';

export type InspectWorkResult =
  | { scope: 'workspace'; state: ReturnType<typeof handleGetWorkState> }
  | { scope: 'task'; context: TaskContextResult; viewerAgentId: string | undefined }
  | ({ scope: 'agent' } & AgentInboxInspection)
  | ({ scope: 'message'; viewerAgentId: string | undefined } & ThreadView)
  | ({ scope: 'search' } & SearchView);

/**
 * `viewer` is who is asking: the session's own agent, or, where Concord cannot
 * see the session, the agent the caller names. Message content is shown only
 * to its sender and recipient. With `message_id` or `task_id`, `agent_id`
 * names the viewer rather than an inbox to inspect, and so it does with `query`.
 */
export function handleInspectWork(
  repos: Repositories,
  input: InspectWorkInput,
  sessionAgentId?: string,
): InspectWorkResult {
  const scoped = [input.task_id, input.message_id, input.query].filter(
    (value) => value !== undefined,
  );
  if (scoped.length > 1) {
    throw new Error(
      'inspect_work accepts only one of task_id, message_id, or query (agent_id may name you ' +
        'beside any of them).',
    );
  }
  if (input.limit !== undefined && input.query === undefined) {
    throw new Error('limit applies only with query.');
  }
  if (input.include_superseded !== undefined && input.task_id === undefined) {
    throw new Error('include_superseded applies only with task_id.');
  }
  if (input.inbox_before !== undefined && (scoped.length !== 0 || input.agent_id === undefined)) {
    throw new Error('inbox_before applies only with an agent_id inbox.');
  }
  const viewer: Viewer | undefined =
    sessionAgentId !== undefined
      ? { agentId: sessionAgentId, verified: true }
      : input.agent_id === undefined
        ? undefined
        : { agentId: input.agent_id, verified: false };
  // A private inbox shows presence only. Other scopes may show a receipt.
  if (scoped.length > 0 || input.agent_id === undefined || viewer?.agentId === input.agent_id) {
    repos.agentMessages.sweepStale();
  }
  if (input.task_id !== undefined) {
    const context = handleGetTaskContext(repos, {
      task_id: input.task_id,
      include_superseded: input.include_superseded,
    });
    return {
      scope: 'task',
      viewerAgentId: viewer?.agentId,
      context: { ...context, messages: visibleTaskMessages(repos, context.messages, viewer) },
    };
  }
  if (input.query !== undefined) {
    return { scope: 'search', ...searchWork(repos, input.query, input.limit, viewer) };
  }
  if (input.message_id !== undefined) {
    return {
      scope: 'message',
      viewerAgentId: viewer?.agentId,
      ...inspectThread(repos, input.message_id, viewer),
    };
  }
  if (input.agent_id !== undefined) {
    return {
      scope: 'agent',
      ...inspectAgentInbox(
        repos,
        input.agent_id,
        viewer ?? { agentId: input.agent_id, verified: false },
        input.inbox_before,
      ),
    };
  }
  return { scope: 'workspace', state: handleGetWorkState(repos) };
}
