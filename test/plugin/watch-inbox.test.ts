import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

/** Runs the monitor until it exits on its own or the timeout stops its poll loop. */
function runMonitor(
  statusFailures: number,
  timeoutMs: number,
): { calls: string[]; exited: boolean } {
  const directory = mkdtempSync(join(tmpdir(), 'concord-watch-inbox-'));
  const fake = fakeConcord(directory);
  const result = spawnSync('bash', [script], {
    cwd: directory,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      CONCORD_BIN: fake.executable,
      CONCORD_TEST_LOG: fake.log,
      CONCORD_TEST_COUNTER: join(directory, 'status-calls'),
      CONCORD_TEST_STATUS_FAILURES: String(statusFailures),
      CONCORD_INBOX_POLL_SECONDS: '0.2',
      CONCORD_INBOX_STARTUP_ATTEMPTS: '3',
      CONCORD_INBOX_STARTUP_BACKOFF_SECONDS: '0',
    },
  });
  const calls = existsSync(fake.log) ? readFileSync(fake.log, 'utf8').trim().split('\n') : [];
  return { calls, exited: result.signal === null && result.status === 0 };
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
});
