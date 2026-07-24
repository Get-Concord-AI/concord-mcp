import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/** Tools whose edits should be gated by the overlap check. */
const MATCHER = 'Edit|Write|MultiEdit';
/** The command Claude Code runs on each matched PreToolUse event. */
export const PRE_TOOL_USE_HOOK_COMMAND = 'concord hook pre-tool-use';
/** The command Claude Code runs once on SessionStart to auto-register presence. */
export const SESSION_START_HOOK_COMMAND = 'concord hook session-start';

const settingsSchema = z
  .object({
    hooks: z
      .object({
        PreToolUse: z.array(z.unknown()).optional(),
        SessionStart: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Append `entry` to the named hook event unless a hook running `command` is
 * already present. Returns the updated event array. */
function withHook(
  existing: readonly unknown[],
  command: string,
  entry: unknown,
): unknown[] {
  const present = existing.some((item) => JSON.stringify(item).includes(command));
  return present ? [...existing] : [...existing, entry];
}

/**
 * Idempotently add Concord's Claude Code hooks to a `settings.json` string: the
 * PreToolUse overlap gate and the SessionStart presence auto-register. Every
 * other setting (and any other hook events) is preserved. Passing the previous
 * output back in is a no-op.
 */
export function upsertClaudeHooks(existing: string | undefined): string {
  const source: unknown =
    existing === undefined || existing.trim() === '' ? {} : JSON.parse(existing);
  const settings = settingsSchema.parse(source);
  const hooks = settings.hooks ?? {};

  const preToolUse = withHook(hooks.PreToolUse ?? [], PRE_TOOL_USE_HOOK_COMMAND, {
    matcher: MATCHER,
    hooks: [{ type: 'command', command: PRE_TOOL_USE_HOOK_COMMAND }],
  });
  const sessionStart = withHook(hooks.SessionStart ?? [], SESSION_START_HOOK_COMMAND, {
    hooks: [{ type: 'command', command: SESSION_START_HOOK_COMMAND }],
  });

  const next = {
    ...settings,
    hooks: { ...hooks, PreToolUse: preToolUse, SessionStart: sessionStart },
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * Write Concord's Claude Code hooks into `<repoRoot>/.claude/settings.json`
 * (created if absent), preserving existing settings. Returns the relative path.
 */
export function installClaudeHook(repoRoot: string): string {
  const relPath = join('.claude', 'settings.json');
  const fullPath = join(repoRoot, relPath);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, upsertClaudeHooks(existing));
  return relPath;
}
