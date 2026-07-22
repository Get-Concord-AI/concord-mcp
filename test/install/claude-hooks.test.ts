import { describe, expect, it } from 'vitest';

import { PRE_TOOL_USE_HOOK_COMMAND, upsertPreToolUseHook } from '../../src/install/claude-hooks.js';

describe('upsertPreToolUseHook', () => {
  it('adds the PreToolUse hook to empty settings', () => {
    const out = upsertPreToolUseHook(undefined);
    expect(out).toContain('PreToolUse');
    expect(out).toContain(PRE_TOOL_USE_HOOK_COMMAND);
    expect(out).toContain('Edit|Write|MultiEdit');
  });

  it('is idempotent: re-running produces identical output', () => {
    const once = upsertPreToolUseHook(undefined);
    const twice = upsertPreToolUseHook(once);
    expect(twice).toBe(once);
  });

  it('preserves unrelated settings and other hook events', () => {
    const existing = JSON.stringify({
      model: 'opus',
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [] }] },
    });
    const out = upsertPreToolUseHook(existing);
    expect(out).toContain('"model": "opus"');
    expect(out).toContain('PostToolUse');
    expect(out).toContain(PRE_TOOL_USE_HOOK_COMMAND);
  });

  it('does not duplicate the hook when one is already present', () => {
    const once = upsertPreToolUseHook(undefined);
    const twice = upsertPreToolUseHook(once);
    const occurrences = twice.split(PRE_TOOL_USE_HOOK_COMMAND).length - 1;
    expect(occurrences).toBe(1);
  });
});
