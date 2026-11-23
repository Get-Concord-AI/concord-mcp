import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  appendTomlBlock,
  concordTomlBlocks,
  removeTomlBlocks,
  vibeHooksPath,
} from './vibe-config.js';

/**
 * Vibe lifecycle hooks live in `~/.vibe/hooks.toml` as `[[hooks]]` tables with
 * `name`, `type` (the event), and `command`. Delivery hooks drain with the
 * `vibe` format, whose snake_case `hook_specific_output.additional_context`
 * is the only hook output Vibe forwards to the model; the rest observe.
 */
interface VibeHookSpec {
  readonly name: string;
  readonly type: string;
  readonly command: string;
}

const DRAIN = 'concord inbox drain --from-hook --provider vibe --format vibe';
const OBSERVE = 'concord inbox observe --provider vibe';

export const VIBE_HOOKS: readonly VibeHookSpec[] = [
  {
    name: 'concord-session-start',
    type: 'session_start',
    command: 'concord hook vibe-session-start',
  },
  { name: 'concord-pre-agent', type: 'pre_agent', command: DRAIN },
  { name: 'concord-post-tool', type: 'post_tool', command: DRAIN },
  { name: 'concord-post-agent', type: 'post_agent', command: OBSERVE },
  { name: 'concord-session-end', type: 'session_end', command: 'concord hook vibe-session-end' },
  { name: 'concord-notification', type: 'notification', command: OBSERVE },
];

const HOOKS_TABLE = 'hooks';
const OWNED = (name: string): boolean => name.startsWith('concord-');

function hookBlock(spec: VibeHookSpec): string {
  return [
    `[[hooks]]`,
    `name = "${spec.name}"`,
    `type = "${spec.type}"`,
    `command = "${spec.command}"`,
  ].join('\n');
}

export function upsertVibeHooksConfig(source: string | undefined): string {
  const current = source ?? '';
  const stripped = removeTomlBlocks(current, HOOKS_TABLE, OWNED);
  return VIBE_HOOKS.reduce((text, spec) => appendTomlBlock(text, hookBlock(spec)), stripped);
}

export function vibeHooksInstalled(source: string): boolean {
  const owned = new Set(
    concordTomlBlocks(source, HOOKS_TABLE, OWNED).map((block) => block.name ?? ''),
  );
  return VIBE_HOOKS.every((spec) => owned.has(spec.name));
}

export function installVibeHooks(env: NodeJS.ProcessEnv = process.env): string {
  const path = vibeHooksPath(env);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const next = upsertVibeHooksConfig(current);
  if (next !== current) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
  }
  return path;
}

export function removeVibeHooks(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = vibeHooksPath(env);
  if (!existsSync(path)) return undefined;
  const current = readFileSync(path, 'utf8');
  const next = removeTomlBlocks(current, HOOKS_TABLE, OWNED);
  if (next === current) return undefined;
  writeFileSync(path, next);
  return path;
}

export function vibeHooksPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = vibeHooksPath(env);
  if (!existsSync(path)) return false;
  try {
    return vibeHooksInstalled(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}
