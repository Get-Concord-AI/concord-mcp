import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  appendTomlBlock,
  bareTomlTableValue,
  concordTomlBlocks,
  dropTomlLine,
  removeTomlBlocks,
  vibeHooksPath,
  type TomlBlock,
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
const HOOK_OWNED_KEYS: ReadonlySet<string> = new Set(['name', 'type', 'command']);

function hookSpec(block: TomlBlock): VibeHookSpec | undefined {
  return VIBE_HOOKS.find((hook) => hook.name === block.name);
}

const hookNamed = (block: TomlBlock): boolean => hookSpec(block) !== undefined;

/**
 * Only the exact hook shape Concord writes is ours. A same-name hook whose
 * command or type differs belongs to the user: setup must neither replace it
 * nor append a competing hook with the same name.
 */
function vibeHookOwned(block: TomlBlock): boolean {
  const spec = hookSpec(block);
  return (
    spec !== undefined &&
    block.fields['type'] === spec.type &&
    block.fields['command'] === spec.command &&
    !block.keysOpaque &&
    !block.envOpaque &&
    block.childTables.length === 0 &&
    block.keys.every((key) => HOOK_OWNED_KEYS.has(key))
  );
}

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
  const bare = bareTomlTableValue(current, HOOKS_TABLE);
  if (bare !== undefined && !bare.empty) return current;
  const base = bare === undefined ? current : dropTomlLine(current, bare.index);
  const namedBlocks = concordTomlBlocks(base, HOOKS_TABLE, hookNamed);
  const foreignNames = new Set(
    namedBlocks.flatMap((block) =>
      !vibeHookOwned(block) && block.name !== undefined ? [block.name] : [],
    ),
  );
  const stripped = removeTomlBlocks(base, HOOKS_TABLE, vibeHookOwned);
  return VIBE_HOOKS.filter((spec) => !foreignNames.has(spec.name)).reduce(
    (text, spec) => appendTomlBlock(text, hookBlock(spec)),
    stripped,
  );
}

/**
 * Every managed hook must be present with its event type and command intact:
 * a name alone would call a user-edited or truncated entry healthy.
 */
export function vibeHooksInstalled(source: string): boolean {
  const blocks = concordTomlBlocks(source, HOOKS_TABLE, vibeHookOwned);
  return VIBE_HOOKS.every((spec) => blocks.some((block) => block.name === spec.name));
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
  let current: string;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // An unreadable config is left untouched so the rest of uninstall proceeds.
    return undefined;
  }
  const next = removeTomlBlocks(current, HOOKS_TABLE, vibeHookOwned);
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
