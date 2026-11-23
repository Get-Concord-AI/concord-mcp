import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

import type { Repositories } from '../../db/index.js';
import { hookSessionId } from '../../domain/identity.js';
import { idsInPrompt, scanTranscript, sessionKey } from '../../domain/receipts.js';
import { recordClientBinding } from '../session-binding.js';

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
    /** The session's project directory, where the harness reports one (Vibe). */
    cwd: z.string().optional(),
    /**
     * Set when the hook fired inside a subagent or a background agent forked
     * from the session, rather than in the session's own conversation.
     */
    agent_id: z.string().optional(),
    /**
     * Vibe spells its subagent marker differently: every payload carries
     * `parent_session_id`, null in the session's own conversation and the
     * parent's session id inside a spawned subagent.
     */
    parent_session_id: z.string().nullable().optional(),
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
  // Vibe names its lifecycle events after the agent loop, not the tools.
  pre_agent: 'UserPromptSubmit',
  post_agent: 'Stop',
  post_tool: 'PostToolUse',
};

function eventName(hook: ObservedHook): string | undefined {
  const name = hook.hook_event_name ?? hook.hookEventName;
  return name === undefined ? undefined : (EVENT_NAMES[name] ?? name);
}

/**
 * The conversation texts a hook's `transcript_path` resolves to, re-read on
 * every call so retries see late writes. Each text is scanned independently:
 * entries are only meaningful in the order their own file wrote them.
 */
type TranscriptTexts = () => readonly (string | undefined)[];

function conversationTexts(hook: ObservedHook): TranscriptTexts | undefined {
  const path = hook.transcript_path ?? hook.transcriptPath ?? undefined;
  if (path === undefined || path === '') return undefined;
  if (basename(path) === 'updates.jsonl') {
    // Grok's hooks point at `updates.jsonl`, its UI event stream; the
    // conversation itself (hook context as `user` entries, the model's turns
    // as `assistant`) is `chat_history.jsonl` beside it.
    const history = join(dirname(path), 'chat_history.jsonl');
    if (existsSync(history)) return () => [readTail(history)];
  }
  try {
    if (statSync(path).isDirectory()) {
      // Vibe's transcript_path is the session directory: chunks/ holds the
      // readable conversation as compacted history snapshots, journal/ the
      // event log the model never sees directly.
      const chunks = join(path, 'chunks');
      if (existsSync(chunks)) return () => vibeChunkTexts(chunks);
      const journal = join(path, 'journal');
      if (existsSync(journal)) return () => [readJournalTail(journal)];
      return undefined;
    }
  } catch {
    return undefined;
  }
  return () => [readTail(path)];
}

/**
 * The tail of a session journal: newest chunks first until the byte budget is
 * spent, then re-ordered oldest→newest so `scanTranscript` sees entries in
 * conversation order. Unread candidates are always recent, so the tail suffices.
 */
function readJournalTail(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch {
    return undefined;
  }
  const parts: string[] = [];
  let budget = TRANSCRIPT_TAIL_BYTES;
  for (const name of names) {
    const text = readTail(join(dir, name), budget);
    if (text === undefined) continue;
    parts.unshift(text);
    budget -= Buffer.byteLength(text, 'utf8');
    if (budget <= 0) break;
  }
  return parts.join('');
}

const vibeChunkPartSchema = z.object({ text: z.string().optional() }).loose();
const vibeChunkEntrySchema = z
  .object({
    message: z
      .object({
        role: z.string().optional(),
        content: z.union([z.string(), z.array(vibeChunkPartSchema)]).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/** One Vibe history entry as a JSONL line `scanTranscript` can classify. */
function vibeChunkLine(raw: unknown): string | undefined {
  const parsed = vibeChunkEntrySchema.safeParse(raw);
  const message = parsed.success ? parsed.data.message : undefined;
  if (message === undefined) return undefined;
  const content = message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => part.text ?? '').join('\n')
        : '';
  if (text.trim() === '') return undefined;
  return JSON.stringify({ role: message.role ?? 'user', content: text });
}

/**
 * Vibe's `chunks/*.json` snapshots make up one ordered conversation, so they
 * are joined oldest→newest (by mtime) into a single text within the byte
 * budget: read evidence that spans two chunks — the delivered message ending
 * one file and the model's reply starting the next — only matches in the
 * joined stream.
 */
function vibeChunkTexts(dir: string): (string | undefined)[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const files = names
    .flatMap((name) => {
      try {
        const path = join(dir, name);
        const stat = statSync(path);
        return [{ path, mtime: stat.mtimeMs, size: stat.size }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  const parts: string[] = [];
  let budget = TRANSCRIPT_TAIL_BYTES;
  for (const file of files) {
    if (budget <= 0) break;
    // The budget bounds raw snapshot bytes, including fields conversion
    // drops: a chunk larger than what remains is skipped, never loaded whole.
    if (file.size > budget) continue;
    let text: string | undefined;
    try {
      const raw: unknown = JSON.parse(readFileSync(file.path, 'utf8'));
      const entries = z.array(z.unknown()).safeParse(raw);
      if (entries.success) {
        text = entries.data
          .map(vibeChunkLine)
          .filter((line): line is string => line !== undefined)
          .join('\n');
      }
    } catch {
      text = undefined;
    }
    if (text !== undefined && text !== '') parts.push(text);
    budget -= file.size;
  }
  // Files were visited newest→oldest for the budget; emit oldest→newest.
  const joined = parts.reverse().join('\n');
  return joined === '' ? [] : [joined];
}

/**
 * Tools that block the turn on a question for the user: Claude Code's own, and
 * the replacement Conductor routes it to (it disables the built-in and aliases
 * it to its own MCP tool, so the session never calls `AskUserQuestion`).
 */
const ASK_USER_TOOLS: readonly string[] = ['AskUserQuestion', 'mcp__conductor__AskUserQuestion'];
/** The most of a transcript read per hook: unread messages are recent. */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
/**
 * Harnesses write their logs asynchronously, so a hook can run just before the
 * model's latest entry lands. When a message is in the transcript with nothing
 * from the model after it yet, read the file again a few times.
 */
const TRANSCRIPT_RETRIES = 4;
const TRANSCRIPT_RETRY_MS = 250;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Ids the transcript proves were read, waiting briefly for a late write. */
function readFromTranscript(texts: TranscriptTexts, candidates: readonly string[]): string[] {
  const found = new Set<string>();
  let remaining = [...candidates];
  for (let attempt = 0; attempt <= TRANSCRIPT_RETRIES && remaining.length > 0; attempt += 1) {
    if (attempt > 0) pause(TRANSCRIPT_RETRY_MS);
    const pending = new Set<string>();
    let sawText = false;
    for (const text of texts()) {
      if (text === undefined) continue;
      sawText = true;
      const scan = scanTranscript(text, remaining);
      for (const id of scan.read) found.add(id);
      for (const id of scan.pending) pending.add(id);
    }
    if (!sawText) break;
    // Only a message already shown, with the model's turn still to land, is worth waiting for.
    remaining = [...pending].filter((id) => !found.has(id));
    if (remaining.length === 0) break;
  }
  return [...found];
}

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
  return (
    (hook?.agent_id !== undefined && hook.agent_id !== '') ||
    (hook?.parent_session_id !== undefined &&
      hook.parent_session_id !== null &&
      hook.parent_session_id !== '')
  );
}

function readTail(path: string, maxBytes: number = TRANSCRIPT_TAIL_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
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
  const texts = conversationTexts(hook);
  if (texts !== undefined) {
    const remaining = candidates.filter((id) => !read.includes(id));
    if (remaining.length > 0) {
      read.push(
        ...repos.agentMessages
          .markRead(agentId, session, readFromTranscript(texts, remaining), 'transcript')
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
 * - `PreToolUse` for `AskUserQuestion` (or Conductor's alias), and a `permission_prompt`
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
  kind?: string,
): Observation {
  const hook = parseObservedHook(rawJson);
  if (hook === undefined || isSubagentHook(hook)) return { read: [], requeued: [] };
  const session = hookSession(rawJson);
  const read = observeRead(repos, agentId, session, hook);
  let requeued: string[] = [];

  switch (eventName(hook)) {
    case 'PreToolUse':
      if (hook.tool_name !== undefined && ASK_USER_TOOLS.includes(hook.tool_name)) {
        awaitUser(repos, agentId);
      }
      break;
    case 'Notification':
      // Vibe reports the same blocked-on-user states as approval/question
      // notifications rather than Claude's permission_prompt.
      if (
        hook.notification_type !== undefined &&
        ['permission_prompt', 'approval_requested', 'question_asked'].includes(
          hook.notification_type,
        )
      ) {
        awaitUser(repos, agentId);
      }
      break;
    case 'SessionStart':
      // A session-start hook sees the session as it is now; binding it here
      // covers every command that observes hooks — including the bundled
      // plugin, which never reaches `concord hook session-start`.
      if (kind !== undefined) recordClientBinding(repos, { agentId, kind });
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
