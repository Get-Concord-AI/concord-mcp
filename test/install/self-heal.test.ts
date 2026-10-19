import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureHarnessAdapter } from '../../src/install/adapters/self-heal.js';

// Links into this checkout count as lasting even when it lives under /tmp.
const LASTING = (): boolean => false;

/** A home where Claude Code is installed but Concord's plugin link is not. */
function claudeMachine(): { env: NodeJS.ProcessEnv; link: string } {
  const home = mkdtempSync(join(tmpdir(), 'concord-self-heal-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho 2.1.223\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const env = { HOME: home, PATH: bin, CLAUDE_CONFIG_DIR: join(home, '.claude') };
  return { env, link: join(home, '.claude', 'skills', 'concord-relay') };
}

describe('ensureHarnessAdapter', () => {
  const options = (env: NodeJS.ProcessEnv, autoAdapters: boolean) => ({
    moduleUrl: import.meta.url,
    env,
    autoAdapters,
    isEphemeral: LASTING,
  });

  it('only reports a missing adapter when the user has not opted in', () => {
    const { env, link } = claudeMachine();
    const result = ensureHarnessAdapter('claude-code', options(env, false));
    expect(result.outcome).toBe('needs_install');
    expect(existsSync(link)).toBe(false);
  });

  it('installs a missing adapter when the user opted in, then finds it healthy', () => {
    const { env, link } = claudeMachine();
    expect(ensureHarnessAdapter('claude-code', options(env, true)).outcome).toBe('repaired');
    expect(existsSync(join(link, '.claude-plugin'))).toBe(true);
    expect(ensureHarnessAdapter('claude-code', options(env, true)).outcome).toBe('healthy');
  });

  it('never replaces a path Concord does not own', () => {
    const { env, link } = claudeMachine();
    mkdirSync(link, { recursive: true });
    const result = ensureHarnessAdapter('claude-code', options(env, true));
    expect(result.outcome).toBe('repair_failed');
    expect(result.detail).toContain('Refusing to replace non-Concord path');
  });

  it('leaves a harness that is not on PATH alone', () => {
    const { env } = claudeMachine();
    expect(ensureHarnessAdapter('grok', options(env, true)).outcome).toBe('healthy');
  });
});
