import type { Repositories, ToolName } from '../db/index.js';
import { z } from 'zod';

/**
 * The task a tool call names, when it names one, so a failure event can be
 * attached to the task the caller was working on.
 *
 * Parsed rather than reached into: an argument object is untrusted input, and
 * `unknown` never escapes this boundary.
 */
export function taskIdFromArgs(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const parsed = z.looseObject({}).safeParse(args);
  const taskId = parsed.success ? parsed.data['task_id'] : undefined;
  return typeof taskId === 'string' && taskId !== '' ? taskId : null;
}

/**
 * An error's message only.
 *
 * Never the stack or any attached property: an error can carry a file path, a
 * configuration value, or a token, and a persisted event is read by more people
 * than the caller that triggered it. Capped so one pathological message cannot
 * bloat the log.
 *
 * Parsed at the boundary, so nothing `unknown` travels further than this line.
 */
export function errorMessage(error: unknown): string {
  const parsed = errorShapeSchema.safeParse(error);
  const message = parsed.success ? parsed.data.message : String(error);
  return message.slice(0, 500);
}

/** The only part of a thrown value this module reads. */
const errorShapeSchema = z.object({ message: z.string() });

/** The subset of an MCP tool response this wrapper needs to preserve. */
type RecordableResponse = Record<string, unknown>;

/**
 * Wrap a tool handler so a durable event is recorded whether it succeeds or
 * fails.
 *
 * Tool implementations record only on their success path, so a validation or
 * runtime throw reached the client but left no event behind — the dashboard and
 * audit trail then showed nothing for a call the user plainly saw fail. Wrapping
 * the dispatch makes every call observable.
 *
 * The error is re-thrown after recording, so the caller's failure response is
 * unchanged: recording must never turn a failure into a success, and it must
 * never swallow the original error.
 *
 * `handler` may return a promise; a rejection is a failure and gets the same
 * event, because an async tool that fails after doing partial work is exactly
 * the case an audit trail needs to see.
 */
export function withRecordedEvents(
  repos: Pick<Repositories, 'events'>,
  onWrite?: () => void,
): <A extends object, T extends RecordableResponse>(
  tool: ToolName,
  handler: (args: A) => T | Promise<T>,
) => (args: A) => T | Promise<T> {
  return <A extends object, T extends RecordableResponse>(
    tool: ToolName,
    handler: (args: A) => T | Promise<T>,
  ) => {
    /**
     * Record a failure, never letting the recording itself change the outcome.
     *
     * A locked database or a full disk must not replace the caller's real error
     * with an event-write error — that would turn a diagnosable failure into a
     * confusing one, and it would make the audit trail the thing that broke the
     * tool. A lost event is recoverable; a masked error is not.
     */
    const record = (args: A, error: unknown): void => {
      // The notification and the event are independent concerns: a full disk
      // must not stop clients learning that work state changed, and a failed
      // notification must not stop the event being written. Each is guarded on
      // its own so neither failure takes the other down with it — and so
      // neither can replace the caller's real error, which is the thing that
      // actually matters.
      try {
        repos.events.record({
          taskId: taskIdFromArgs(args),
          tool,
          status: 'error',
          // The message only: an error can carry a path, a value, or a token, and
          // the event log is not a place to persist those.
          detail: errorMessage(error),
        });
      } catch {
        // The event is dropped; the caller still gets the original error.
      }
      try {
        // The event is a change to work state, so clients need the same
        // resource-changed notification a successful write triggers. Without it a
        // dashboard shows nothing until some unrelated write happens to notify,
        // and the failure just recorded stays invisible.
        onWrite?.();
      } catch {
        // The notification is dropped; the caller still gets the original error.
      }
    };
    return (args: A): T | Promise<T> => {
      let result: T | Promise<T>;
      try {
        result = handler(args);
      } catch (error) {
        record(args, error);
        throw error;
      }
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          record(args, error);
          throw error;
        });
      }
      return result;
    };
  };
}

/**
 * Record a failure a tool surfaced by returning an error result rather than
 * throwing.
 *
 * Some tools catch a specific failure and return `isError: true` so the client
 * gets a structured response. Those never reach the dispatch wrapper, so
 * without this the audit trail would miss a failure the caller plainly saw.
 *
 * Never throws: a locked database or a full disk must not turn a diagnosable
 * failure into a confusing one.
 */
export function recordRejectedCall(
  repos: Pick<Repositories, 'events'>,
  tool: ToolName,
  args: unknown,
  error: unknown,
  onWrite?: () => void,
): void {
  try {
    repos.events.record({
      taskId: taskIdFromArgs(args),
      tool,
      status: 'error',
      detail: errorMessage(error),
    });
  } catch {
    // The event is dropped; the caller still gets the original error.
  }
  try {
    onWrite?.();
  } catch {
    // The notification is dropped; the caller still gets the original error.
  }
}
