import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';
import {
  hasMcpServer,
  isConcordServerOwned,
  McpConfigParseError,
  removeMcpServer,
  upsertMcpServer,
} from './mcp-config.js';

/**
 * Kiro keeps MCP servers and hooks under `.kiro/settings/mcp.json` and
 * `.kiro/hooks/` in a workspace, and the same layout under `~/.kiro` for the
 * user. Hooks are Kiro's v1 JSON format: a `version` and a list of named hooks
 * whose `action.command` runs with the event payload on stdin.
 */

export function kiroHome(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.kiro');
}

export function kiroWorkspaceMcpPath(repoRoot: string): string {
  return join(repoRoot, '.kiro', 'settings', 'mcp.json');
}

export function kiroUserMcpPath(env: NodeJS.ProcessEnv): string {
  return join(kiroHome(env), 'settings', 'mcp.json');
}

/** Repo-relative path of the workspace hooks file. */
export const KIRO_WORKSPACE_HOOKS_RELATIVE = join('.kiro', 'hooks', 'concord.json');

export function kiroWorkspaceHooksPath(repoRoot: string): string {
  return join(repoRoot, KIRO_WORKSPACE_HOOKS_RELATIVE);
}

export function kiroUserHooksPath(env: NodeJS.ProcessEnv): string {
  return join(kiroHome(env), 'hooks', 'concord.json');
}

export interface KiroHookSpec {
  readonly name: string;
  readonly trigger: string;
  readonly command: string;
}

/**
 * SessionStart prints the agent id into the session; UserPromptSubmit and Stop
 * drain the durable inbox into a running turn. Kiro has no idle wake-up, so a
 * message sent between turns waits until one of these events fires.
 */
export const KIRO_HOOKS: readonly KiroHookSpec[] = [
  {
    name: 'concord-session-start',
    trigger: 'SessionStart',
    command: 'concord hook kiro-session-start',
  },
  {
    name: 'concord-user-prompt-submit',
    trigger: 'UserPromptSubmit',
    command: 'concord hook kiro-user-prompt-submit',
  },
  {
    name: 'concord-stop',
    trigger: 'Stop',
    command: 'concord hook kiro-stop',
  },
];

const CONCORD_HOOK_PREFIX = 'concord-';

const kiroHookSchema = z
  .object({
    name: z.string().optional(),
    trigger: z.string().optional(),
    action: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const kiroHooksFileSchema = z
  .object({
    version: z.string().optional(),
    hooks: z.array(kiroHookSchema).optional(),
  })
  .loose();

type KiroHookEntry = z.infer<typeof kiroHookSchema>;
type KiroHooksFile = z.infer<typeof kiroHooksFileSchema>;

function isConcordHook(hook: KiroHookEntry): boolean {
  return (hook.name ?? '').startsWith(CONCORD_HOOK_PREFIX);
}

function hookEntry(hook: KiroHookSpec): KiroHookEntry {
  return {
    name: hook.name,
    trigger: hook.trigger,
    action: { type: 'command', command: hook.command },
  };
}

/**
 * Add Concord's hooks to Kiro's v1 hooks file, preserving unrelated hooks and
 * top-level keys. Re-running it replaces only Concord's entries.
 */
export function upsertKiroHooks(existing: string | undefined, displayPath: string): string {
  let parsed: KiroHooksFile;
  try {
    const source: unknown =
      existing === undefined || existing.trim() === '' ? {} : JSON.parse(existing);
    parsed = kiroHooksFileSchema.parse(source);
  } catch {
    throw new McpConfigParseError(displayPath);
  }
  if (parsed.version !== undefined && parsed.version !== 'v1') {
    throw new McpConfigParseError(displayPath, `uses unsupported hooks version ${parsed.version}`);
  }
  const kept = (parsed.hooks ?? []).filter((hook) => !isConcordHook(hook));
  return `${JSON.stringify(
    { ...parsed, version: 'v1', hooks: [...kept, ...KIRO_HOOKS.map(hookEntry)] },
    null,
    2,
  )}\n`;
}

/** Whether a Kiro hooks file registers all of Concord's lifecycle hooks. */
export function hasKiroHooks(existing: string): boolean {
  try {
    const parsed = kiroHooksFileSchema.safeParse(JSON.parse(existing));
    if (!parsed.success) return false;
    const hooks = parsed.data.hooks ?? [];
    return KIRO_HOOKS.every((spec) =>
      hooks.some(
        (hook) =>
          hook.name === spec.name &&
          hook.trigger === spec.trigger &&
          hook.action?.['type'] === 'command' &&
          hook.action['command'] === spec.command,
      ),
    );
  } catch {
    return false;
  }
}

/**
 * Remove Concord's hooks, keeping unrelated hooks and top-level settings.
 * Returns '' only when nothing user-authored remains, so the caller can delete
 * the file. A malformed file throws for the caller to report.
 */
export function withoutKiroHooks(existing: string): string {
  const parsed = kiroHooksFileSchema.parse(JSON.parse(existing));
  const { version, ...settings } = parsed;
  delete settings.hooks;
  const hooks = (parsed.hooks ?? []).filter((hook) => !isConcordHook(hook));
  if (hooks.length === 0 && Object.keys(settings).length === 0) return '';
  return `${JSON.stringify(
    {
      ...(version === undefined ? {} : { version }),
      ...settings,
      ...(hooks.length === 0 ? {} : { hooks }),
    },
    null,
    2,
  )}\n`;
}

function writeHooksFile(path: string, displayPath: string): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const updated = upsertKiroHooks(existing, displayPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, updated);
}

/** Write the workspace hooks file; returns its repo-relative path. */
export function installKiroWorkspaceHooks(repoRoot: string): string {
  writeHooksFile(kiroWorkspaceHooksPath(repoRoot), KIRO_WORKSPACE_HOOKS_RELATIVE);
  return KIRO_WORKSPACE_HOOKS_RELATIVE;
}

/**
 * Register the user-level MCP server and hooks so Kiro sessions outside a
 * repository prepared by `concord setup` still get identity and delivery.
 * Returns the absolute paths written.
 */
export function installKiroUserConfigs(env: NodeJS.ProcessEnv): string[] {
  const mcpPath = kiroUserMcpPath(env);
  const existing = existsSync(mcpPath) ? readFileSync(mcpPath, 'utf8') : undefined;
  if (existing === undefined || !hasMcpServer(existing) || isConcordServerOwned(existing)) {
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, upsertMcpServer(existing, undefined, { CONCORD_AGENT_KIND: 'kiro' }));
  }
  const hooksPath = kiroUserHooksPath(env);
  writeHooksFile(hooksPath, hooksPath);
  return [mcpPath, hooksPath];
}

/** Whether Kiro is installed: its CLI, its IDE launcher, or a Kiro config directory. */
export function kiroDetected(
  executable: string | undefined,
  repoRoot: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    executable !== undefined ||
    existsSync(kiroHome(env)) ||
    (repoRoot !== undefined && existsSync(join(repoRoot, '.kiro')))
  );
}

/** Remove only what Concord owns from Kiro's user-level files. */
export function uninstallKiroUserConfigs(env: NodeJS.ProcessEnv): void {
  const mcpPath = kiroUserMcpPath(env);
  if (existsSync(mcpPath)) {
    try {
      const existing = readFileSync(mcpPath, 'utf8');
      if (hasMcpServer(existing) && isConcordServerOwned(existing)) {
        writeFileSync(mcpPath, removeMcpServer(existing));
      }
    } catch {
      // Unreadable or malformed config is left untouched.
    }
  }
  const hooksPath = kiroUserHooksPath(env);
  if (!existsSync(hooksPath)) return;
  try {
    const rest = withoutKiroHooks(readFileSync(hooksPath, 'utf8'));
    if (rest === '') rmSync(hooksPath);
    else writeFileSync(hooksPath, rest);
  } catch {
    // Unreadable or malformed hooks config is left untouched.
  }
}
