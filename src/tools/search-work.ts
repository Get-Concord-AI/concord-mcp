import type { HandoffRecord, Repositories } from '../db/index.js';
import type { Viewer } from './inspect-messages.js';

/**
 * `inspect_work` with `query`: keyword search over this workspace's task
 * updates and handoff packets, and over the viewer's own messages. Each hit
 * names the `message_id` or `task_id` to open next, so an agent finds earlier
 * work without reading every thread into its context.
 *
 * Messages stay private as everywhere else: without a viewer, none are
 * searched. Searching never marks a message read; a snippet in a result list
 * is not the message shown whole. The response mirrors Concord Cloud's.
 */

export const DEFAULT_SEARCH_LIMIT = 20;
const SNIPPET = 240;

export interface SearchHit {
  source: 'message' | 'update' | 'handoff';
  taskId: string | null;
  messageId: string | null;
  kind: string | null;
  agentId: string | null;
  createdAt: string;
  snippet: string;
}

export interface SearchView {
  query: string;
  results: SearchHit[];
}

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * About `SNIPPET` characters of `text` around the first match of `query`, cut
 * by code point so no surrogate pair is split. Where the match cannot be
 * placed, the start is shown.
 */
export function snippetOf(text: string, query: string): string {
  const flat = flatten(text);
  const characters = Array.from(flat);
  if (characters.length <= SNIPPET) return flat;
  const unit = flat.toLowerCase().indexOf(flatten(query).toLowerCase());
  const at = unit < 0 ? 0 : Array.from(flat.slice(0, unit)).length;
  const start = Math.max(0, Math.min(at - SNIPPET / 3, characters.length - SNIPPET));
  const end = start + SNIPPET;
  return (
    (start > 0 ? '…' : '') +
    characters.slice(start, end).join('').trim() +
    (end < characters.length ? '…' : '')
  );
}

/** The handoff field that matched, whole, followed by the summary for context. */
function handoffText(handoff: HandoffRecord, query: string): string {
  const needle = flatten(query).toLowerCase();
  const matched = [
    ...handoff.nextSteps,
    ...handoff.decisions,
    ...handoff.assumptions,
    ...handoff.knownRisks,
  ].find((item) => flatten(item).toLowerCase().includes(needle));
  return matched === undefined || flatten(handoff.whatChanged).toLowerCase().includes(needle)
    ? handoff.whatChanged
    : `${matched} (${handoff.whatChanged})`;
}

export function searchWork(
  repos: Repositories,
  query: string,
  limit: number | undefined,
  viewer: Viewer | undefined,
): SearchView {
  const max = limit ?? DEFAULT_SEARCH_LIMIT;
  const messages = viewer === undefined ? [] : repos.search.messagesFor(viewer.agentId, query, max);
  const hits: SearchHit[] = [
    ...messages.map((message): SearchHit => ({
      source: 'message',
      taskId: message.taskId,
      messageId: message.messageId,
      kind: null,
      agentId: message.senderAgentId,
      createdAt: message.createdAt,
      snippet: snippetOf(message.content, query),
    })),
    ...repos.search.taskUpdates(query, max).map((update): SearchHit => ({
      source: 'update',
      taskId: update.taskId,
      messageId: null,
      kind: update.kind,
      agentId: update.agent,
      createdAt: update.createdAt,
      snippet: snippetOf(update.content, query),
    })),
    ...repos.search.handoffs(query, max).map((handoff): SearchHit => ({
      source: 'handoff',
      taskId: handoff.taskId,
      messageId: null,
      kind: handoff.status,
      agentId: handoff.fromAgentId,
      createdAt: handoff.createdAt,
      snippet: snippetOf(handoffText(handoff, query), query),
    })),
  ];
  return {
    query,
    results: hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, max),
  };
}

/** One line per hit, each naming how to open it, for clients that show only text. */
export function searchText(view: SearchView): string {
  if (view.results.length === 0) return `No results for "${view.query}".`;
  return [
    `${String(view.results.length)} result(s) for "${view.query}", newest first:`,
    ...view.results.map((hit) => {
      const label = hit.source === 'update' ? (hit.kind ?? 'update') : hit.source;
      const open =
        hit.messageId !== null
          ? ` (open with inspect_work message_id=${hit.messageId})`
          : hit.taskId !== null
            ? ` (open with inspect_work task_id=${hit.taskId})`
            : '';
      return `- [${label}] ${hit.createdAt} by ${hit.agentId ?? 'unknown'}: ${hit.snippet}${open}`;
    }),
  ].join('\n');
}
