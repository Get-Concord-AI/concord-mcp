import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/** Tools whose edits should be gated by the overlap check. */
const MATCHER = 'Edit|Write|MultiEdit';
/** The command Claude Code runs on each matched PreToolUse event. */
export const PRE_TOOL_USE_HOOK_COMMAND = 'concord hook pre-tool-use';

const settingsSchema = z
  .object({
    hooks: z
      .object({ PreToolUse: z.array(z.unknown()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Idempotently add Concord's PreToolUse overlap hook to a `settings.json` string,
 * preserving every other setting (and any other hook events). Returns the new
 * file content. Passing the previous output back in is a no-op.
 */
export function upsertPreToolUseHook(existing: string | undefined): string {
  const source: unknown =
    existing === undefined || existing.trim() === '' ? {} : JSON.parse(existing);
  const settings = settingsSchema.parse(source);
  const hooks = settings.hooks ?? {};
  const preToolUse = hooks.PreToolUse ?? [];

  const alreadyInstalled = preToolUse.some((entry) =>
    JSON.stringify(entry).includes(PRE_TOOL_USE_HOOK_COMMAND),
  );
  const nextPreToolUse = alreadyInstalled
    ? preToolUse
    : [
        ...preToolUse,
        { matcher: MATCHER, hooks: [{ type: 'command', command: PRE_TOOL_USE_HOOK_COMMAND }] },
      ];

  const next = { ...settings, hooks: { ...hooks, PreToolUse: nextPreToolUse } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * Write the PreToolUse hook into `<repoRoot>/.claude/settings.json` (created if
 * absent), preserving existing settings. Returns the relative path written.
 */
export function installClaudeHook(repoRoot: string): string {
  const relPath = join('.claude', 'settings.json');
  const fullPath = join(repoRoot, relPath);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, upsertPreToolUseHook(existing));
  return relPath;
}
