import type { EventRecord, ToolName } from '../db/index.js';

/** Which required workflow stages are present in the compatible event history. */
export interface TaskAdoption {
  taskId: string;
  startWork: boolean;
  finishWork: boolean;
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
    startWork: tools.has('claim_work'),
    finishWork: tools.has('handoff'),
    reviewReady: tools.has('review_ready'),
  }));
}
