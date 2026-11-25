import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { devinMcpConfigPath } from './devin-config.js';
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

function commandFor(event: (typeof EVENTS)[number]): string {
  return `concord hook devin-${event
    .replace(/([A-Z])/gu, '-$1')
    .toLowerCase()
    .replace(/^-/, '')}`;
}

function isConcordHook(value: JsonValue): boolean {
  return (
    isJsonObject(value) &&
    value['type'] === 'command' &&
    typeof value['command'] === 'string' &&
    value['command'].startsWith('concord hook devin-')
  );
}

function entryContainsCommand(entry: JsonValue, command: string): boolean {
  if (!isJsonObject(entry) || !Array.isArray(entry['hooks'])) return false;
  return entry['hooks'].some(
    (hook) => isJsonObject(hook) && hook['type'] === 'command' && hook['command'] === command,
  );
}

function removeConcordCommands(entry: JsonValue): {
  value: JsonValue | undefined;
  changed: boolean;
} {
  if (!isJsonObject(entry) || !Array.isArray(entry['hooks'])) {
    return { value: entry, changed: false };
  }
  const hooks = entry['hooks'];
  const kept = hooks.filter((hook) => !isConcordHook(hook));
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

function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(devinMcpConfigPath(env)), 'config.json');
}

export function upsertDevinUserHooksConfig(existing: string | undefined): string {
  const source = existing ?? '{}';
  const config = parseJsoncObject(source);
  const previous = config['hooks'];
  if (
    previous !== undefined &&
    (typeof previous !== 'object' || previous === null || Array.isArray(previous))
  ) {
    throw new Error('Devin config hooks must be an object.');
  }
  const hooks = jsonObjectSchema.parse(previous ?? {});
  const nextHooks = { ...hooks };
  for (const event of EVENTS) {
    const current = hooks[event];
    const entries = Array.isArray(current) ? current : [];
    const command = commandFor(event);
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
  const clean = uncomment(source);
  const rootOpen = clean.indexOf('{');
  const close = objectEnd(clean, rootOpen);
  const hasEntries = Object.keys(config).length > 0;
  return `${source.slice(0, close)}${hasEntries ? ',' : ''}\n  "hooks": ${next}\n${source.slice(close)}`;
}

export function removeDevinUserHooksConfig(existing: string): string {
  const config = parseJsoncObject(existing);
  const current = config['hooks'];
  if (current === undefined || !isJsonObject(current)) return existing;
  const hooks = current;
  const nextHooks = { ...hooks };
  let changed = false;
  for (const event of EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const results = entries.map(removeConcordCommands);
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
  const clean = uncomment(existing);
  const rootOpen = clean.indexOf('{');
  const rootClose = objectEnd(clean, rootOpen);
  return removeProperty(existing, { open: rootOpen, close: rootClose }, range);
}

export function installDevinUserHooks(env: NodeJS.ProcessEnv = process.env): string {
  const path = userConfigPath(env);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const next = upsertDevinUserHooksConfig(existing);
  if (next !== existing) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, { mode: 0o600 });
  }
  return path;
}

export function removeDevinUserHooks(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = userConfigPath(env);
  if (!existsSync(path)) return undefined;
  const existing = readFileSync(path, 'utf8');
  const next = removeDevinUserHooksConfig(existing);
  if (next === existing) return undefined;
  writeFileSync(path, next);
  return path;
}

export function devinUserHooksInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = userConfigPath(env);
  if (!existsSync(path)) return false;
  try {
    const config = parseJsoncObject(readFileSync(path, 'utf8'));
    const hooks = config['hooks'];
    if (hooks === undefined || !isJsonObject(hooks)) return false;
    return EVENTS.every((event) => {
      const entries = hooks[event];
      return (
        Array.isArray(entries) &&
        entries.some((entry) => entryContainsCommand(entry, commandFor(event)))
      );
    });
  } catch {
    return false;
  }
}
