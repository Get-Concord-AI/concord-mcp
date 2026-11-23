import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  installVibeHooks,
  removeVibeHooks,
  upsertVibeHooksConfig,
  VIBE_HOOKS,
  vibeHooksInstalled,
  vibeHooksPresent,
} from '../../src/install/vibe-hooks.js';
import { vibeHooksPath } from '../../src/install/vibe-config.js';

const dirs: string[] = [];

function tempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'vibe-hooks-'));
  dirs.push(home);
  return { VIBE_HOME: join(home, '.vibe') };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('upsertVibeHooksConfig', () => {
  it('writes every lifecycle event Concord needs', () => {
    const next = upsertVibeHooksConfig(undefined);
    for (const spec of VIBE_HOOKS) {
      expect(next).toContain(`name = "${spec.name}"`);
      expect(next).toContain(`type = "${spec.type}"`);
      expect(next).toContain(`command = "${spec.command}"`);
    }
    expect(vibeHooksInstalled(next)).toBe(true);
  });

  it('drains on the turn boundaries and observes elsewhere', () => {
    const next = upsertVibeHooksConfig(undefined);
    const drainCount = (next.match(/inbox drain --from-hook --provider vibe --format vibe/gu) ?? [])
      .length;
    // pre_agent and post_tool deliver; post_agent and notification only observe.
    expect(drainCount).toBe(2);
    expect(next).toContain('concord inbox observe --provider vibe');
    expect(next).toContain('concord hook vibe-session-start');
    expect(next).toContain('concord hook vibe-session-end');
  });

  it('preserves user hooks and is idempotent', () => {
    const userHook = [
      '[[hooks]]',
      'name = "mine"',
      'type = "session_start"',
      'command = "echo hi"',
      '',
    ].join('\n');
    const once = upsertVibeHooksConfig(userHook);
    expect(once).toContain('name = "mine"');
    expect(once).toContain('command = "echo hi"');
    expect(upsertVibeHooksConfig(once)).toBe(once);
  });

  it('replaces a stale concord hook block instead of duplicating it', () => {
    const once = upsertVibeHooksConfig(undefined);
    const stale = once.replace('concord hook vibe-session-end', 'concord hook old-event');
    const fixed = upsertVibeHooksConfig(stale);
    expect(fixed.match(/name = "concord-session-end"/gu)).toHaveLength(1);
    expect(fixed).not.toContain('old-event');
  });
});

describe('vibe hooks install', () => {
  it('installs, reports present, and removes only concord hooks', () => {
    const env = tempEnv();
    const path = vibeHooksPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      ['[[hooks]]', 'name = "mine"', 'type = "session_start"', 'command = "echo hi"', ''].join(
        '\n',
      ),
    );
    installVibeHooks(env);
    const written = readFileSync(path, 'utf8');
    expect(vibeHooksInstalled(written)).toBe(true);
    expect(vibeHooksPresent(env)).toBe(true);
    expect(written).toContain('name = "mine"');

    removeVibeHooks(env);
    const next = readFileSync(path, 'utf8');
    expect(next).toContain('name = "mine"');
    expect(next).not.toContain('concord-');
    expect(vibeHooksPresent(env)).toBe(false);
  });
});
