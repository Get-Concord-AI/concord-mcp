import { describe, expect, it } from 'vitest';

import {
  PRE_TOOL_USE_HOOK_COMMAND,
  SESSION_START_HOOK_COMMAND,
  upsertClaudeHooks,
} from '../../src/install/claude-hooks.js';

describe('upsertClaudeHooks', () => {
  it('adds the PreToolUse and SessionStart hooks to empty settings', () => {
    const out = upsertClaudeHooks(undefined);
    expect(out).toContain('PreToolUse');
    expect(out).toContain(PRE_TOOL_USE_HOOK_COMMAND);
    expect(out).toContain('Edit|Write|MultiEdit');
    expect(out).toContain('SessionStart');
    expect(out).toContain(SESSION_START_HOOK_COMMAND);
  });

  it('is idempotent: re-running produces identical output', () => {
    const once = upsertClaudeHooks(undefined);
    const twice = upsertClaudeHooks(once);
    expect(twice).toBe(once);
  });

  it('preserves unrelated settings and other hook events', () => {
    const existing = JSON.stringify({
      model: 'opus',
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [] }] },
    });
    const out = upsertClaudeHooks(existing);
    expect(out).toContain('"model": "opus"');
    expect(out).toContain('PostToolUse');
    expect(out).toContain(PRE_TOOL_USE_HOOK_COMMAND);
    expect(out).toContain(SESSION_START_HOOK_COMMAND);
  });

  it('does not duplicate hooks when they are already present', () => {
    const once = upsertClaudeHooks(undefined);
    const twice = upsertClaudeHooks(once);
    expect(twice.split(PRE_TOOL_USE_HOOK_COMMAND).length - 1).toBe(1);
    expect(twice.split(SESSION_START_HOOK_COMMAND).length - 1).toBe(1);
  });
});
