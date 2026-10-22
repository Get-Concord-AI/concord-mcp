import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

import type { Repositories } from '../../db/index.js';
import { hookSessionId } from '../../domain/identity.js';
import { idsInPrompt, idsReadInTranscript, sessionKey } from '../../domain/receipts.js';

/**
 * What a session's own hooks reveal about the messages it was handed.
 *
 * A harness monitor drains a message the moment it arrives, but the harness
 * may hold the notification — for as long as the agent is blocked on a
 * question or permission prompt for its user. Only the session can say when
 * its model was actually shown a message, and only by naming the message id:
 * in the prompt that started a turn, or in the session transcript followed by
 * something the model wrote. Timing alone never counts.
 */

/** The parts of a hook payload this reads; everything else is ignored. */
const observedHookSchema = z
  .object({
    hook_event_name: z.string().optional(),
    /** SessionStart: startup, resume, clear, or compact. */
    source: z.string().optional(),
    /** SessionEnd: clear, logout, prompt_input_exit, other. */
    reason: z.string().optional(),
    /** UserPromptSubmit: the prompt, including a monitor notification that started the turn. */
    prompt: z.string().optional(),
    /** PreToolUse: the tool about to run. */
    tool_name: z.string().optional(),
    /** Notification: why the harness is asking for the user's attention. */
    notification_type: z.string().optional(),
    /** The session's conversation so far, where the harness exposes one. */
    transcript_path: z.string().nullable().optional(),
    /**
     * Set when the hook fired inside a subagent or a background agent forked
     * from the session, rather than in the session's own conversation.
     */
    agent_id: z.string().optional(),
    /** Grok spells its payload in camelCase. */
    hookEventName: z.string().optional(),
    transcriptPath: z.string().nullable().optional(),
  })
  .loose();

export type ObservedHook = z.infer<typeof observedHookSchema>;

/** Hook event names as some harnesses spell them (`post_tool_use`), in Claude Code's form. */
const EVENT_NAMES: Readonly<Record<string, string>> = {
  session_start: 'SessionStart',
  user_prompt_submit: 'UserPromptSubmit',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  notification: 'Notification',
  stop: 'Stop',
  session_end: 'SessionEnd',
};

function eventName(hook: ObservedHook): string | undefined {
  const name = hook.hook_event_name ?? hook.hookEventName;
  return name === undefined ? undefined : (EVENT_NAMES[name] ?? name);
}

/**
 * The file holding what the model was actually sent. Grok's hooks point at
 * `updates.jsonl`, its UI event stream; the conversation itself (hook context
 * as `user` entries, the model's turns as `assistant`) is `chat_history.jsonl`
 * beside it.
 */
function conversationFile(hook: ObservedHook): string | undefined {
  const path = hook.transcript_path ?? hook.transcriptPath ?? undefined;
  if (path === undefined || path === '') return undefined;
  if (basename(path) === 'updates.jsonl') {
    const history = join(dirname(path), 'chat_history.jsonl');
    if (existsSync(history)) return history;
  }
  return path;
}

/** Claude Code's tool that blocks the turn on a question for the user. */
const ASK_USER_TOOL = 'AskUserQuestion';
/** The most of a transcript read per hook: unread messages are recent. */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

export interface Observation {
  /** Messages this event proved the agent's model was shown. */
  read: string[];
  /** Unread messages returned to the queue for this agent's new session. */
  requeued: string[];
}

export function parseObservedHook(rawJson: string): ObservedHook | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  const result = observedHookSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** The session key a hook payload belongs to, when it names one. */
export function hookSession(rawJson: string): string | null {
  const raw = hookSessionId(rawJson);
  return raw === undefined ? null : sessionKey(raw);
}

/** A hook fired by a subagent or a forked background agent, not the session itself. */
export function isSubagentHook(hook: ObservedHook | undefined): boolean {
  return hook?.agent_id !== undefined && hook.agent_id !== '';
}

function readTail(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Mark read whatever this hook's prompt or transcript proves the model was shown. */
function observeRead(
  repos: Repositories,
  agentId: string,
  session: string | null,
  hook: ObservedHook,
): string[] {
  const unread = repos.agentMessages.listUnreadForSession(agentId, session);
  if (unread.length === 0) return [];
  const candidates = unread.map((message) => message.messageId);
  const read: string[] = [];
  if (hook.prompt !== undefined) {
    const shown = idsInPrompt(hook.prompt).filter((id) => candidates.includes(id));
    read.push(
      ...repos.agentMessages
        .markRead(agentId, session, shown, 'prompt')
        .map((message) => message.messageId),
    );
  }
  const transcriptPath = conversationFile(hook);
  if (transcriptPath !== undefined) {
    const remaining = candidates.filter((id) => !read.includes(id));
    const text = remaining.length === 0 ? undefined : readTail(transcriptPath);
    if (text !== undefined) {
      read.push(
        ...repos.agentMessages
          .markRead(agentId, session, idsReadInTranscript(text, remaining), 'transcript')
          .map((message) => message.messageId),
      );
    }
  }
  return read;
}

/**
 * Apply one hook event to `agentId`'s messages and presence.
 *
 * - Any hook from the session itself can carry read evidence (its prompt or
 *   transcript). Hooks fired inside a subagent are ignored: a subagent's
 *   activity is not proof the session's own model saw anything.
 * - `PreToolUse` for `AskUserQuestion`, and a `permission_prompt`
 *   notification, mean the session is about to block on its user. Recorded so
 *   a sender can be told; delivery is never held on it, because dismissing a
 *   prompt with Esc or Deny fires no hook to clear it.
 * - `SessionEnd`: whatever this session was handed and never read goes back
 *   to the queue.
 * - `SessionStart` from `startup` is a new session for this agent: anything
 *   delivered to an earlier session but never read is queued again. A
 *   `resume` restores the earlier session along with what it was holding, so
 *   requeueing there would show the agent the same message twice.
 */
export function observeHookEvent(
  repos: Repositories,
  agentId: string,
  rawJson: string,
): Observation {
  const hook = parseObservedHook(rawJson);
  if (hook === undefined || isSubagentHook(hook)) return { read: [], requeued: [] };
  const session = hookSession(rawJson);
  const read = observeRead(repos, agentId, session, hook);
  let requeued: string[] = [];

  switch (eventName(hook)) {
    case 'PreToolUse':
      if (hook.tool_name === ASK_USER_TOOL) awaitUser(repos, agentId);
      break;
    case 'Notification':
      if (hook.notification_type === 'permission_prompt') awaitUser(repos, agentId);
      break;
    case 'SessionStart':
      repos.agentEndpoints.setAwaitingUser(agentId, null);
      if (hook.source === 'startup') {
        requeued = repos.agentMessages
          .requeueUnread(agentId, session)
          .map((message) => message.messageId);
      }
      break;
    case 'SessionEnd':
      // A session that ended will never read what it was handed but did not
      // show. Requeued, it reaches this agent's next session or expires.
      // `/clear` ends the conversation but not the process: its monitor keeps
      // delivering, so requeueing would only hand the message straight back.
      if (session !== null && hook.reason !== 'clear') {
        requeued = repos.agentMessages
          .requeueSession(agentId, session)
          .map((message) => message.messageId);
      }
      break;
    case undefined:
      break;
    default:
      // UserPromptSubmit, PostToolUse, Stop and the like: the session moved on,
      // so whatever it was waiting on its user for has been answered. With
      // parallel tool calls this can clear early; the flag is advisory.
      repos.agentEndpoints.setAwaitingUser(agentId, null);
  }
  return { read, requeued };
}

function awaitUser(repos: Repositories, agentId: string): void {
  repos.agentEndpoints.setAwaitingUser(agentId, new Date().toISOString());
}
