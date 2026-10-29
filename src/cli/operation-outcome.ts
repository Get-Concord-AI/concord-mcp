import type { TelemetryOutcome } from '../telemetry/events.js';

/**
 * A command that reports a user-facing failure without throwing leaves
 * `process.exitCode` set. Usage reports must record that as an error even
 * though `postAction` ran normally.
 */
export function operationOutcome(exitCode: typeof process.exitCode): TelemetryOutcome {
  return exitCode === undefined || exitCode === 0 || exitCode === '0' ? 'success' : 'error';
}
