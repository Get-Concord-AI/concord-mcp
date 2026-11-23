import type { SemanticTelemetryEvent, TelemetryRecorder } from './events.js';

export type TaskTransition = Extract<
  SemanticTelemetryEvent,
  { event_type: 'task_lifecycle' }
>['transition'];

/** The pseudonymized flow id for a task, or undefined when telemetry is off. */
export function taskFlowId(
  telemetry: TelemetryRecorder | undefined,
  taskId: string,
): string | undefined {
  return telemetry?.taskPseudonym(taskId) ?? undefined;
}

/** Emit a `task_lifecycle` event when the task can be pseudonymized. */
export function recordTaskTransition(
  telemetry: TelemetryRecorder | undefined,
  taskId: string,
  transition: TaskTransition,
  status: string,
): void {
  const flowId = taskFlowId(telemetry, taskId);
  if (flowId === undefined) return;
  telemetry?.recordEvent({
    event_type: 'task_lifecycle',
    task_flow_id: flowId,
    transition,
    status,
    elapsed_ms: null,
  });
}
