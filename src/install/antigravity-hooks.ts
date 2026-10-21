import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { userHome } from '../config/paths.js';

export const ANTIGRAVITY_HOOKS = {
  SessionStart: [
    {
      command: 'concord hook session-start --client antigravity',
    },
  ],
  PreInvocation: [
    {
      command: 'concord hook pre-invocation --client antigravity',
      timeout: 5,
    },
  ],
  Stop: [
    {
      command: 'concord hook stop --client antigravity',
      timeout: 5,
    },
  ],
} as const;

export const ANTIGRAVITY_HOOK_KEY = 'concord';

const hooksConfigSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

const antigravityHooksCheckSchema = z
  .object({
    concord: z
      .object({
        SessionStart: z.array(z.object({ command: z.string() }).loose()),
        PreInvocation: z.array(z.object({ command: z.string() }).loose()),
      })
      .loose(),
  })
  .loose();

/**
 * Thrown when an existing hooks.json file cannot be parsed. The file is left
 * untouched rather than overwritten.
 */
export class HooksConfigParseError extends Error {
  constructor(
    readonly path: string,
    problem = 'is not valid JSON',
  ) {
    super(`${path} ${problem} — fix or remove it, then re-run.`);
    this.name = 'HooksConfigParseError';
  }
}

/**
 * Idempotently add or update Concord's lifecycle hooks in an Antigravity hooks.json.
 * Any other named hook entries are preserved. Throws HooksConfigParseError on syntax error.
 */
export function upsertAntigravityHooks(
  existing: string | undefined,
  path = '.agents/hooks.json',
): string {
  let parsed: z.infer<typeof hooksConfigSchema> = {};
  if (existing !== undefined && existing.trim() !== '') {
    try {
      const raw: unknown = JSON.parse(existing);
      parsed = hooksConfigSchema.parse(raw);
    } catch {
      throw new HooksConfigParseError(path);
    }
  }

  const updated = {
    ...parsed,
    [ANTIGRAVITY_HOOK_KEY]: ANTIGRAVITY_HOOKS,
  };

  return `${JSON.stringify(updated, null, 2)}\n`;
}

/**
 * Remove Concord's hooks from an Antigravity hooks.json string, preserving any other hooks.
 */
export function removeAntigravityHooks(existing: string, path = '.agents/hooks.json'): string {
  if (existing.trim() === '') return '{}\n';
  try {
    const raw: unknown = JSON.parse(existing);
    const parsed = hooksConfigSchema.parse(raw);
    const remaining = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== ANTIGRAVITY_HOOK_KEY),
    );
    return `${JSON.stringify(remaining, null, 2)}\n`;
  } catch {
    throw new HooksConfigParseError(path);
  }
}

/**
 * Whether an Antigravity hooks.json registers Concord's hooks.
 */
export function hasAntigravityHooks(existing: string): boolean {
  try {
    if (existing.trim() === '') return false;
    const raw: unknown = JSON.parse(existing);
    const parsed = antigravityHooksCheckSchema.safeParse(raw);
    return (
      parsed.success &&
      parsed.data.concord.SessionStart.length > 0 &&
      parsed.data.concord.PreInvocation.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Write Concord's lifecycle hooks into `.agents/hooks.json` under repoRoot.
 */
export function installAntigravityHooks(repoRoot: string): string {
  const relPath = join('.agents', 'hooks.json');
  const fullPath = join(repoRoot, relPath);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
  const updated = upsertAntigravityHooks(existing, relPath);

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, updated);
  return relPath;
}

/**
 * Path to global Antigravity hooks.json (~/.gemini/config/hooks.json).
 */
export function globalAntigravityHooksPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(userHome(env), '.gemini', 'config', 'hooks.json');
}

/**
 * Install Concord hooks in the global Antigravity config directory.
 */
export function installGlobalAntigravityHooks(env: NodeJS.ProcessEnv = process.env): string {
  const path = globalAntigravityHooksPath(env);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const updated = upsertAntigravityHooks(existing, path);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, updated, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  return path;
}

/**
 * Remove Concord hooks from the global Antigravity config directory.
 */
export function uninstallGlobalAntigravityHooks(env: NodeJS.ProcessEnv = process.env): void {
  const path = globalAntigravityHooksPath(env);
  if (!existsSync(path)) return;
  let updated: string;
  try {
    const existing = readFileSync(path, 'utf8');
    updated = removeAntigravityHooks(existing, path);
  } catch {
    // Malformed hooks file is left untouched at the uninstall boundary.
    return;
  }
  try {
    const trimmed = updated.trim();
    if (trimmed === '{}' || trimmed === '') {
      rmSync(path);
    } else {
      writeFileSync(path, updated, { mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(path, 0o600);
    }
  } catch (error) {
    process.stderr.write(
      `Concord: failed to remove Antigravity hooks from ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
