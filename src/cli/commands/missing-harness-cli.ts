/**
 * One-line report for a harness CLI that is not on `PATH`.
 *
 * The adapter launchers run before any relay starts, so a missing harness is
 * a user error, not a Concord bug: printing an install hint and leaving
 * `exitCode = 1` behind keeps Node from dumping a stack trace for something
 * the user can fix.
 */
export interface ErrorStream {
  write(chunk: string): void;
}

export function reportMissingHarnessCli(
  displayName: string,
  installCommand: string,
  stderr: ErrorStream = process.stderr,
): void {
  stderr.write(
    `Concord: ${displayName} was not found on PATH. ` +
      `Install it (${installCommand}) and try again.\n`,
  );
  process.exitCode = 1;
}
