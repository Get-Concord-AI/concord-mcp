import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const script = resolve('plugin/concord-relay/scripts/watch-inbox.sh');

/**
 * A stand-in `concord` that logs every call and fails `inbox status` a set
 * number of times before succeeding, like a store that is briefly unavailable
 * while a resumed session's previous process shuts down.
 */
function fakeConcord(directory: string): { executable: string; log: string } {
  const executable = join(directory, 'concord');
  const log = join(directory, 'calls.log');
  writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$CONCORD_TEST_LOG"',
      'case "$*" in',
      '  "inbox status --cloud") exit 1 ;;',
      '  "inbox status")',
      '    n=$(cat "$CONCORD_TEST_COUNTER" 2>/dev/null || echo 0)',
      '    n=$((n + 1))',
      '    echo "$n" > "$CONCORD_TEST_COUNTER"',
      '    [ "$n" -gt "$CONCORD_TEST_STATUS_FAILURES" ] && exit 0',
      '    exit 1 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  return { executable, log };
}

/**
 * A stand-in `sleep`, put first on `PATH`, that logs how long it was asked to
 * wait and returns at once, so the backoff can be checked without waiting.
 */
function fakeSleep(directory: string): string {
  const log = join(directory, 'sleeps.log');
  writeFileSync(
    join(directory, 'sleep'),
    ['#!/bin/sh', `printf "%s\\n" "$1" >> "${log}"`, 'exit 0', ''].join('\n'),
  );
  chmodSync(join(directory, 'sleep'), 0o755);
  return log;
}

interface MonitorOptions {
  /** Overrides the startup knobs; `undefined` leaves a knob unset so its default applies. */
  readonly startup?: { attempts?: string; backoffSeconds?: string };
  /** Replaces `sleep` with a logger that returns at once. */
  readonly recordSleeps?: boolean;
}

const fastStartup = { attempts: '3', backoffSeconds: '0' };

/** Runs the monitor until it exits on its own or the timeout stops its poll loop. */
function runMonitor(
  statusFailures: number,
  timeoutMs: number,
  { startup = fastStartup, recordSleeps = false }: MonitorOptions = {},
): { calls: string[]; exited: boolean; sleeps: string[] } {
  const directory = mkdtempSync(join(tmpdir(), 'concord-watch-inbox-'));
  const fake = fakeConcord(directory);
  const sleepLog = recordSleeps ? fakeSleep(directory) : undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONCORD_BIN: fake.executable,
    CONCORD_TEST_LOG: fake.log,
    CONCORD_TEST_COUNTER: join(directory, 'status-calls'),
    CONCORD_TEST_STATUS_FAILURES: String(statusFailures),
    CONCORD_INBOX_POLL_SECONDS: '0.2',
  };
  delete env['CONCORD_INBOX_STARTUP_ATTEMPTS'];
  delete env['CONCORD_INBOX_STARTUP_BACKOFF_SECONDS'];
  if (startup.attempts !== undefined) env['CONCORD_INBOX_STARTUP_ATTEMPTS'] = startup.attempts;
  if (startup.backoffSeconds !== undefined) {
    env['CONCORD_INBOX_STARTUP_BACKOFF_SECONDS'] = startup.backoffSeconds;
  }
  if (sleepLog !== undefined) {
    env['PATH'] = `${directory}${delimiter}${process.env['PATH'] ?? ''}`;
  }
  const result = spawnSync('bash', [script], {
    cwd: directory,
    encoding: 'utf8',
    timeout: timeoutMs,
    // SIGKILL, not the default SIGTERM: the script traps TERM to release its
    // receiver and exit 0, which would look like a clean exit here. A kill
    // that cannot be trapped is what "still polling at the deadline" means.
    killSignal: 'SIGKILL',
    env,
  });
  const lines = (file: string | undefined): string[] =>
    file !== undefined && existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
  return {
    calls: lines(fake.log),
    exited: result.signal === null && result.status === 0,
    sleeps: lines(sleepLog),
  };
}

const statusChecks = (calls: readonly string[]): number =>
  calls.filter((call) => call === 'inbox status').length;
const drains = (calls: readonly string[]): number =>
  calls.filter((call) => call.startsWith('inbox drain')).length;

describe.skipIf(process.platform === 'win32')('Claude Code relay monitor startup', () => {
  it('starts polling after a first successful workspace check', () => {
    const { calls, exited } = runMonitor(0, 2_000);

    expect(exited).toBe(false);
    expect(statusChecks(calls)).toBe(1);
    expect(drains(calls)).toBeGreaterThan(0);
  });

  it('rides out a transient workspace-check failure instead of exiting for good', () => {
    const { calls, exited } = runMonitor(2, 2_000);

    expect(exited).toBe(false);
    expect(statusChecks(calls)).toBe(3);
    expect(drains(calls)).toBeGreaterThan(0);
  });

  it('exits quietly once every attempt says this is not a Concord workspace', () => {
    const { calls, exited } = runMonitor(1_000, 10_000);

    expect(exited).toBe(true);
    expect(statusChecks(calls)).toBe(3);
    expect(drains(calls)).toBe(0);
  });

  it('waits 1s then 2s between workspace checks by default', () => {
    const { calls, exited, sleeps } = runMonitor(1_000, 10_000, {
      startup: {},
      recordSleeps: true,
    });

    expect(exited).toBe(true);
    expect(statusChecks(calls)).toBe(3);
    expect(sleeps).toEqual(['1', '2']);
  });

  it.each([
    ['a fractional backoff', { backoffSeconds: '0.5' }],
    ['a non-integer attempt count', { attempts: '3.0' }],
    ['a negative attempt count', { attempts: '-1' }],
    ['a zero attempt count', { attempts: '0' }],
    ['an empty backoff', { backoffSeconds: '' }],
  ])('falls back to the defaults given %s', (_label, startup) => {
    const { calls, exited, sleeps } = runMonitor(1_000, 10_000, { startup, recordSleeps: true });

    expect(exited).toBe(true);
    expect(statusChecks(calls)).toBe(3);
    expect(sleeps).toEqual(['1', '2']);
  });
});
