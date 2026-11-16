import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { parseAgentMessageRow } from '../message-rows.js';
import { LOCAL_PROJECT } from '../project-scope-migration.js';
import {
  parseHandoffRow,
  parseTaskUpdateRow,
  type AgentMessageRecord,
  type HandoffRecord,
  type TaskUpdateRecord,
} from '../rows.js';

/**
 * Case-insensitive keyword search over what agents wrote down: messages,
 * task updates, and handoff packets. Each listing is newest first and bounded
 * by `limit`. Updates and handoffs are scoped to `project`, like every other
 * task-scoped repository; messages span the store, so they are narrowed to one
 * agent's own conversations instead.
 *
 * SQLite's LIKE is case-insensitive for ASCII, which is enough for keywords.
 */
export interface SearchRepository {
  messagesFor(agentId: string, query: string, limit: number): AgentMessageRecord[];
  taskUpdates(query: string, limit: number): TaskUpdateRecord[];
  handoffs(query: string, limit: number): HandoffRecord[];
}

const rawListSchema = z.array(z.unknown());

/** `%` and `_` are wildcards in LIKE; a search for them means the characters. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export function createSearchRepository(
  db: ConcordDatabase,
  project: string = LOCAL_PROJECT,
): SearchRepository {
  const messagesStmt = db.prepare(`
    SELECT * FROM agent_messages
    WHERE (sender_agent_id = @agent OR recipient_agent_id = @agent)
      AND content LIKE @pattern ESCAPE '\\'
    ORDER BY created_at DESC, message_id DESC
    LIMIT @limit
  `);
  const updatesStmt = db.prepare(`
    SELECT * FROM task_updates
    WHERE project = @project AND content LIKE @pattern ESCAPE '\\'
    ORDER BY created_at DESC, id DESC
    LIMIT @limit
  `);
  // List columns hold JSON arrays; each item is matched, never the JSON around it.
  const listMatches = (column: string) =>
    `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END) ` +
    `AS item WHERE item.type = 'text' AND item.value LIKE @pattern ESCAPE '\\')`;
  const handoffsStmt = db.prepare(`
    SELECT * FROM handoffs
    WHERE project = @project AND (
      what_changed LIKE @pattern ESCAPE '\\'
      OR ${listMatches('next_steps')}
      OR ${listMatches('decisions')}
      OR ${listMatches('assumptions')}
      OR ${listMatches('known_risks')}
    )
    ORDER BY created_at DESC, id DESC
    LIMIT @limit
  `);

  return {
    messagesFor(agentId, query, limit) {
      const raw: unknown = messagesStmt.all({ agent: agentId, pattern: likePattern(query), limit });
      return rawListSchema.parse(raw).map(parseAgentMessageRow);
    },
    taskUpdates(query, limit) {
      const raw: unknown = updatesStmt.all({ project, pattern: likePattern(query), limit });
      return rawListSchema.parse(raw).map(parseTaskUpdateRow);
    },
    handoffs(query, limit) {
      const raw: unknown = handoffsStmt.all({ project, pattern: likePattern(query), limit });
      return rawListSchema.parse(raw).map(parseHandoffRow);
    },
  };
}
