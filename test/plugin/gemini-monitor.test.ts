import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const script = resolve('plugin/gemini/concord-relay/hooks/session-register.mjs');
const hooks = resolve('plugin/gemini/concord-relay/hooks/hooks.json');
const hookDefinitionSchema = z.object({
  hooks: z.record(
    z.string(),
    z.array(z.object({ hooks: z.array(z.object({ command: z.string(), timeout: z.number() })) })),
  ),
});

function fakeConcord(directory: string): { executable: string; log: string } {
  const isWindows = process.platform === 'win32';
  const executable = join(directory, isWindows ? 'concord.cmd' : 'concord');
  const log = join(directory, 'calls.log');

  if (isWindows) {
    writeFileSync(
      executable,
      `@echo off\r\necho %*>> "%CONCORD_TEST_LOG%"\r\necho registered\r\n`,
    );
  }
  else {
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CONCORD_TEST_LOG"\ncat >/dev/null\necho registered\n',
  );
  chmodSync(executable, 0o755);
  }
  return { executable, log };
}

describe('Gemini background inbox monitor', () => {
  it('registers quietly and injects a session-bound background command', () => {
    const directory = mkdtempSync(join(tmpdir(), 'concord-gemini-register-'));
    const fake = fakeConcord(directory);
    const output = execFileSync(process.execPath, [script], {
      cwd: directory,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'gemini-session' }),
      env: {
        ...process.env,
        CONCORD_EXECUTABLE: fake.executable,
        CONCORD_TEST_LOG: fake.log,
      },
    });
    const response = z
      .object({
        suppressOutput: z.boolean(),
        hookSpecificOutput: z.object({
          hookEventName: z.string(),
          additionalContext: z.string(),
        }),
      })
      .parse(JSON.parse(output));

    expect(response.suppressOutput).toBe(true);
    expect(response.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(response.hookSpecificOutput.additionalContext).toContain(
      'concord inbox watch --agent gemini:46ae1e56 --provider gemini --once',
    );
    expect(response.hookSpecificOutput.additionalContext).toContain('is_background: true');
    expect(readFileSync(fake.log, 'utf8')).toContain(
      'inbox register --from-hook --provider gemini',
    );
  });

  it('gives each Gemini hook more than the SQLite busy timeout', () => {
    const definition = hookDefinitionSchema.parse(JSON.parse(readFileSync(hooks, 'utf8')));
    const configured = Object.values(definition.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks),
    );

    expect(configured).toHaveLength(3);
    expect(configured.every((hook) => hook.timeout === 15_000)).toBe(true);
    expect(configured[0]?.command).toContain('session-register.mjs');
  });
});
