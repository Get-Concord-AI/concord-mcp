import { Command } from '@commander-js/extra-typings';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerInboxCommand } from '../../src/cli/commands/inbox.js';
import { openContext } from '../../src/cli/context.js';

const AGENT = 'claude-code:aaaa1111';
const FAILED = /^Concord: could not check for messages before the question: .+\n$/u;

/** `concord inbox drain --format pre-tool-use` in a local workspace. */
describe('the pre-question hook never fails', () => {
  let repoRoot: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    // A home of its own, so the machine is never linked to the developer's Cloud.
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'concord-hook-home-')));
    repoRoot = mkdtempSync(join(tmpdir(), 'concord-hook-repo-'));
    vi.stubEnv('CONCORD_REPO_ROOT', repoRoot);
    // The drain's own identity, whichever harness session runs the tests.
    vi.stubEnv('CONCORD_AGENT_ID', AGENT);
    // No hook payload on stdin: a TTY is read as none, so the test never waits on it.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(process.stdin, 'isTTY');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  async function preToolUse(...extra: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerInboxCommand(program);
    await program.parseAsync([
      'node',
      'concord',
      'inbox',
      'drain',
      '--format',
      'pre-tool-use',
      ...extra,
    ]);
  }

  it('lets the question open when the inbox belongs to another agent', async () => {
    openContext(repoRoot);

    // resolveInboxOwner refuses: this session is AGENT, not the one asked for.
    await preToolUse('--agent', 'claude-code:bbbb2222');

    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(FAILED);
    expect(stderr[0]).toContain('cannot take messages addressed to claude-code:bbbb2222');
    expect(process.exitCode).toBeUndefined();
  });

  it('lets the question open when the database cannot be used', async () => {
    mkdirSync(join(repoRoot, '.concord'), { recursive: true });
    writeFileSync(join(repoRoot, '.concord', 'concord.db'), 'not a sqlite database');

    await preToolUse();

    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(FAILED);
    expect(process.exitCode).toBeUndefined();
  });
});
