import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  isJsonObject,
  objectEnd,
  parseJsoncObject,
  propertyObject,
  removeProperty,
  uncomment,
} from './jsonc-edit.js';
import { jsonObjectSchema, type JsonObject, type JsonValue } from './json-value.js';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'SessionEnd'] as const;

/**
 * Per-harness knobs for the shared lifecycle-hooks machinery: where the
 * harness keeps its config.json and which `concord hook <prefix>-*` commands
 * identify Concord-managed entries.
 */
interface HooksConfigOps {
  configPath(env: NodeJS.ProcessEnv): string;
  commandPrefix: string;
  label: string;
}

function commandFor(event: (typeof EVENTS)[number], prefix: string): string {
  return `concord hook ${prefix}-${event
    .replace(/([A-Z])/gu, '-$1')
    .toLowerCase()
    .replace(/^-/, '')}`;
}

function isConcordHook(value: JsonValue, prefix: string): boolean {
  return (
    isJsonObject(value) &&
    value['type'] === 'command' &&
    typeof value['command'] === 'string' &&
    value['command'].startsWith(`concord hook ${prefix}-`)
  );
}

function entryContainsCommand(entry: JsonValue, command: string): boolean {
  if (!isJsonObject(entry) || !Array.isArray(entry['hooks'])) return false;
  return entry['hooks'].some(
    (hook) => isJsonObject(hook) && hook['type'] === 'command' && hook['command'] === command,
  );
}

function removeConcordCommands(
  entry: JsonValue,
  prefix: string,
): {
  value: JsonValue | undefined;
  changed: boolean;
} {
  if (!isJsonObject(entry) || !Array.isArray(entry['hooks'])) {
    return { value: entry, changed: false };
  }
  const hooks = entry['hooks'];
  const kept = hooks.filter((hook) => !isConcordHook(hook, prefix));
  if (kept.length === hooks.length) return { value: entry, changed: false };
  return { value: kept.length === 0 ? undefined : { ...entry, hooks: kept }, changed: true };
}

function commentsIn(text: string): string[] {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu) ?? [];
  return tokens.filter((token) => token.startsWith('//') || token.startsWith('/*'));
}

function formatNestedObject(value: JsonObject, comments: readonly string[] = []): string {
  const formatted = JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
  if (comments.length === 0) return formatted;
  return `${formatted.slice(0, -1)}\n${comments.map((comment) => `  ${comment}`).join('\n')}\n}`;
}

export function upsertHooksConfig(existing: string | undefined, ops: HooksConfigOps): string {
  const source = existing ?? '{}';
  const config = parseJsoncObject(source);
  const previous = config['hooks'];
  if (
    previous !== undefined &&
    (typeof previous !== 'object' || previous === null || Array.isArray(previous))
  ) {
    throw new Error(`${ops.label} config hooks must be an object.`);
  }
  const hooks = jsonObjectSchema.parse(previous ?? {});
  const nextHooks = { ...hooks };
  for (const event of EVENTS) {
    const current = hooks[event];
    const entries = Array.isArray(current) ? current : [];
    const command = commandFor(event, ops.commandPrefix);
    if (!entries.some((entry) => entryContainsCommand(entry, command))) {
      nextHooks[event] = [...entries, { matcher: '', hooks: [{ type: 'command', command }] }];
    }
  }
  if (JSON.stringify(nextHooks) === JSON.stringify(hooks)) return source;

  const range = propertyObject(source, 'hooks');
  const next = formatNestedObject(
    nextHooks,
    range === undefined ? [] : commentsIn(source.slice(range.open, range.close + 1)),
  );
  if (range !== undefined)
    return `${source.slice(0, range.open)}${next}${source.slice(range.close + 1)}`;
  const rootOpen = uncomment(source).indexOf('{');
  const close = objectEnd(source, rootOpen);
  const hasEntries = Object.keys(config).length > 0;
  return `${source.slice(0, close)}${hasEntries ? ',' : ''}\n  "hooks": ${next}\n${source.slice(close)}`;
}

export function removeHooksConfig(existing: string, ops: HooksConfigOps): string {
  const config = parseJsoncObject(existing);
  const current = config['hooks'];
  if (current === undefined || !isJsonObject(current)) return existing;
  const hooks = current;
  const nextHooks = { ...hooks };
  let changed = false;
  for (const event of EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const results = entries.map((entry) => removeConcordCommands(entry, ops.commandPrefix));
    if (!results.some((result) => result.changed)) continue;
    changed = true;
    const kept = results.flatMap((result) => (result.value === undefined ? [] : [result.value]));
    if (kept.length === 0) Reflect.deleteProperty(nextHooks, event);
    else nextHooks[event] = kept;
  }
  if (!changed) return existing;
  const range = propertyObject(existing, 'hooks');
  if (range === undefined) return existing;
  if (Object.keys(nextHooks).length > 0) {
    const formatted = formatNestedObject(
      nextHooks,
      commentsIn(existing.slice(range.open, range.close + 1)),
    );
    return `${existing.slice(0, range.open)}${formatted}${existing.slice(range.close + 1)}`;
  }
  const rootOpen = uncomment(existing).indexOf('{');
  const rootClose = objectEnd(existing, rootOpen);
  return removeProperty(existing, { open: rootOpen, close: rootClose }, range);
}

export function installHooks(ops: HooksConfigOps, env: NodeJS.ProcessEnv = process.env): string {
  const path = ops.configPath(env);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const next = upsertHooksConfig(existing, ops);
  if (next !== existing) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, { mode: 0o600 });
  }
  return path;
}

export function removeHooks(
  ops: HooksConfigOps,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path = ops.configPath(env);
  if (!existsSync(path)) return undefined;
  const existing = readFileSync(path, 'utf8');
  const next = removeHooksConfig(existing, ops);
  if (next === existing) return undefined;
  writeFileSync(path, next);
  return path;
}

export function hooksInstalled(ops: HooksConfigOps, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = ops.configPath(env);
  if (!existsSync(path)) return false;
  try {
    const config = parseJsoncObject(readFileSync(path, 'utf8'));
    const hooks = config['hooks'];
    if (hooks === undefined || !isJsonObject(hooks)) return false;
    return EVENTS.every((event) => {
      const entries = hooks[event];
      return (
        Array.isArray(entries) &&
        entries.some((entry) => entryContainsCommand(entry, commandFor(event, ops.commandPrefix)))
      );
    });
  } catch {
    return false;
  }
}
