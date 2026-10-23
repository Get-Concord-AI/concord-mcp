import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const watchInbox = resolve('plugin/concord-relay/scripts/watch-inbox.sh');

// spawnSync inherits the test runner's cwd, which is the repo root, so the
// script path must be absolute for the child to find it.

/**
 * Run the monitor with a stub `concord` on PATH. `statusGate` decides how the
 * startup gate behaves; `drain` how the poll loop does. Returns what the stub
 * saw so a test can assert the monitor kept going.
 */
function runMonitor(options: {
  statusGate: 'workspace' | 'not-a-workspace' | 'flaky' | 'always-unknown';
  sleepSeconds?: number;
  gateAttempts?: number;
}): { exitCode: number | null; calls: readonly string[]; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'concord-monitor-'));
  const bin = join(dir, 'bin');
  const calls = join(dir, 'calls.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(calls, '');

  // The gate fails `flaky` twice before succeeding, modelling SQLITE_BUSY
  // while the previous session's process is still shutting down. `$CALLS_FILE`
  // must reach the stub at run time, so it is escaped against expansion here.
  const gate = {
    // 0 = workspace, 2 = definitively not one, 1 = could not tell (transient).
    workspace: 'echo "Concord workspace present."; exit 0',
    'always-unknown': 'exit 1',
    'not-a-workspace': 'exit 2',
    flaky:
      'n=$(grep -c "inbox status" "$CALLS_FILE" || true); if [ "$n" -lt 3 ]; then exit 1; fi; echo "Concord workspace present."; exit 0',
  }[options.statusGate];

  // The bash variables are expanded by the child, not by this template.
  const stub = `#!/usr/bin/env bash
echo "$*" >> "$CALLS_FILE"
# The cloud probe must answer before the generic status check, or the monitor
# takes the cloud path instead of the drain loop under test.
if [ "\${1:-}" = "inbox" ] && [ "\${2:-}" = "status" ] && [ "\${3:-}" = "--cloud" ]; then
  exit 1
fi
if [ "\${1:-}" = "inbox" ] && [ "\${2:-}" = "status" ]; then
  ${gate}
fi
if [ "\${1:-}" = "inbox" ] && [ "\${2:-}" = "drain" ]; then
  exit 0
fi
exit 0
`;
  const concord = join(bin, 'concord');
  writeFileSync(concord, stub);
  chmodSync(concord, 0o755);

  const result = spawnSync('bash', [watchInbox], {
    encoding: 'utf8',
    timeout: 4_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      CALLS_FILE: calls,
      CONCORD_BIN: concord,
      CONCORD_INBOX_POLL_SECONDS: String(options.sleepSeconds ?? 0.2),
      CONCORD_INBOX_GATE_SECONDS: '0.05',
      CONCORD_INBOX_GATE_ATTEMPTS: String(options.gateAttempts ?? 30),
    },
  });

  const seen = readFileSync(calls, 'utf8');
  const recorded = seen.split('\n').filter((line) => line !== '');
  // Clean up even when the run fails, so repeated test runs do not accumulate.
  rmSync(dir, { recursive: true, force: true });
  return { exitCode: result.status ?? null, calls: recorded, stderr: result.stderr };
}

describe('relay watch-inbox monitor', () => {
  it('exits immediately when the directory is not a Concord workspace', () => {
    const run = runMonitor({ statusGate: 'not-a-workspace' });

    expect(run.calls.filter((call) => call === 'inbox status')).toHaveLength(1);
    expect(run.calls.some((call) => call.startsWith('inbox drain'))).toBe(false);
  });

  it('gives up after the attempt limit rather than retrying forever', () => {
    const run = runMonitor({
      statusGate: 'always-unknown',
      gateAttempts: 3,
      sleepSeconds: 0.05,
    });

    // Exactly the limit, then a clean exit — no drain loop, no hang.
    expect(run.calls.filter((call) => call === 'inbox status')).toHaveLength(3);
    expect(run.calls.some((call) => call.startsWith('inbox drain'))).toBe(false);
    expect(run.exitCode).toBe(0);
  });

  it('retries the startup gate instead of exiting on a transient failure', () => {
    // A resume can briefly contend on SQLite or start with a different PATH.
    // The gate must survive that; exiting here kills delivery for the session.
    const run = runMonitor({ statusGate: 'flaky', sleepSeconds: 0.05 });

    expect(run.calls.filter((call) => call === 'inbox status').length).toBeGreaterThanOrEqual(3);
    expect(run.calls.some((call) => call.startsWith('inbox drain'))).toBe(true);
  });
});
