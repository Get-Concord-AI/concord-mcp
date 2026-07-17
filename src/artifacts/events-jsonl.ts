import type { EventRecord } from '../db/index.js';

/** Render events.jsonl: one JSON object per line, in chronological order. */
export function renderEventsJsonl(events: readonly EventRecord[]): string {
  if (events.length === 0) {
    return '';
  }
  return `${events
    .map((event) =>
      JSON.stringify({
        task_id: event.taskId,
        tool: event.tool,
        status: event.status,
        detail: event.detail,
        created_at: event.createdAt,
      }),
    )
    .join('\n')}\n`;
}
