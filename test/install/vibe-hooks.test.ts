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

  it('keeps a user hook that merely starts with concord-', () => {
    const userHook = [
      '[[hooks]]',
      'name = "concord-lint"',
      'type = "post_tool"',
      'command = "npm run lint"',
      '',
    ].join('\n');
    const once = upsertVibeHooksConfig(userHook);
    expect(once).toContain('name = "concord-lint"');
    expect(once).toContain('command = "npm run lint"');
  });

  it('does not replace or duplicate a same-name hook whose command drifted', () => {
    const once = upsertVibeHooksConfig(undefined);
    const stale = once.replace('concord hook vibe-session-end', 'concord hook old-event');
    const fixed = upsertVibeHooksConfig(stale);
    expect(fixed.match(/name = "concord-session-end"/gu)).toHaveLength(1);
    expect(fixed).toContain('old-event');
  });

  it('keeps a user hook with a Concord name without appending a competitor', () => {
    const userHook = [
      '[[hooks]]',
      'name = "concord-session-start"',
      'type = "session_start"',
      'command = "echo user-hook"',
      '',
    ].join('\n');
    const next = upsertVibeHooksConfig(userHook);
    expect(next.match(/name = "concord-session-start"/gu)).toHaveLength(1);
    expect(next).toContain('command = "echo user-hook"');
    expect(next).toContain('name = "concord-pre-agent"');
    expect(upsertVibeHooksConfig(next)).toBe(next);
  });

  it('decodes escaped concord hook names before deciding ownership', () => {
    const userHook = [
      '[[hooks]]',
      'name = "\\u0063oncord-session-start"',
      'type = "session_start"',
      'command = "echo user-hook"',
      '',
    ].join('\n');
    const next = upsertVibeHooksConfig(userHook);
    expect(next).toContain('name = "\\u0063oncord-session-start"');
    expect(next).toContain('command = "echo user-hook"');
    expect(next).not.toContain('name = "concord-session-start"');
    expect(next.split('type = "session_start"')).toHaveLength(2);
    expect(vibeHooksInstalled(next)).toBe(false);
    expect(upsertVibeHooksConfig(next)).toBe(next);
  });

  it('treats same-name hooks with extra keys or child tables as user-owned', () => {
    for (const extra of ['enabled = false', '[hooks.settings]\ntimeout = 3']) {
      const userHook = [
        '[[hooks]]',
        'name = "concord-session-start"',
        'type = "session_start"',
        'command = "concord hook vibe-session-start"',
        extra,
        '',
      ].join('\n');
      const next = upsertVibeHooksConfig(userHook);
      expect(next.match(/name = "concord-session-start"/gu)).toHaveLength(1);
      expect(next).toContain(extra.split('\n')[0] ?? '');
    }
  });

  it('converts an empty hooks array and leaves other values untouched', () => {
    const next = upsertVibeHooksConfig('hooks = []\n');
    expect(next).not.toContain('hooks = []');
    expect(vibeHooksInstalled(next)).toBe(true);
    const source = 'hooks = [{ name = "mine" }]\n';
    expect(upsertVibeHooksConfig(source)).toBe(source);
  });

  it('does not count hooks with drifted type or command as installed', () => {
    const drifted = upsertVibeHooksConfig(undefined).replace(
      'concord inbox observe --provider vibe',
      'echo hi',
    );
    expect(vibeHooksInstalled(drifted)).toBe(false);
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

  it('uninstall keeps a user hook that merely starts with concord-', () => {
    const env = tempEnv();
    const path = vibeHooksPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        '[[hooks]]',
        'name = "concord-lint"',
        'type = "post_tool"',
        'command = "npm run lint"',
        '',
      ].join('\n'),
    );
    installVibeHooks(env);
    removeVibeHooks(env);
    const next = readFileSync(path, 'utf8');
    expect(next).toContain('name = "concord-lint"');
    expect(next).toContain('command = "npm run lint"');
    expect(next).not.toContain('concord-session-start');
  });

  it('uninstall keeps a same-name user hook with a different command', () => {
    const env = tempEnv();
    const path = vibeHooksPath(env);
    mkdirSync(dirname(path), { recursive: true });
    const source = [
      '[[hooks]]',
      'name = "concord-session-start"',
      'type = "session_start"',
      'command = "echo user-hook"',
      '',
    ].join('\n');
    writeFileSync(path, source);
    installVibeHooks(env);
    removeVibeHooks(env);
    const next = readFileSync(path, 'utf8');
    expect(next.match(/name = "concord-session-start"/gu)).toHaveLength(1);
    expect(next).toContain('command = "echo user-hook"');
  });
});
