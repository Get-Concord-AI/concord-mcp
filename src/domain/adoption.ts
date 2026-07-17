import type { EventRecord, ToolName } from '../db/index.js';

/** Which of the three v0 tools have been called for a task. */
export interface TaskAdoption {
  taskId: string;
  claimWork: boolean;
  handoff: boolean;
  reviewReady: boolean;
}

/**
 * Summarize tool adoption per task from the event log. This makes skipped tools
 * visible even on clients where the workflow cannot be enforced.
 */
export function buildAdoption(events: readonly EventRecord[]): TaskAdoption[] {
  const byTask = new Map<string, Set<ToolName>>();
  for (const event of events) {
    if (event.taskId === null) {
      continue;
    }
    const tools = byTask.get(event.taskId) ?? new Set<ToolName>();
    tools.add(event.tool);
    byTask.set(event.taskId, tools);
  }

  return [...byTask.entries()].map(([taskId, tools]) => ({
    taskId,
    claimWork: tools.has('claim_work'),
    handoff: tools.has('handoff'),
    reviewReady: tools.has('review_ready'),
  }));
}
