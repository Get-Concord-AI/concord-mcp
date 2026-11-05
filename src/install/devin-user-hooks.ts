import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { devinMcpConfigPath } from './devin-config.js';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'SessionEnd'] as const;
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const objectSchema = z.record(z.string(), jsonValueSchema);

interface ObjectRange {
  key: number;
  open: number;
  close: number;
}

function commandFor(event: (typeof EVENTS)[number]): string {
  return `concord hook devin-${event
    .replace(/([A-Z])/gu, '-$1')
    .toLowerCase()
    .replace(/^-/, '')}`;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function uncomment(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (part, quoted: string | undefined) => quoted ?? part.replace(/[^\r\n]/gu, ' '),
  );
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function objectEnd(clean: string, open: number, key: string): number {
  let depth = 0;
  let inString = false;
  for (let index = open; index < clean.length; index += 1) {
    const char = clean[index];
    if (char === '"' && !isEscaped(clean, index)) inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return index;
  }
  throw new Error(`Unclosed ${key} object`);
}

/**
 * The object value of `key` directly inside the root object. A key of the same
 * name nested deeper (say a server named "hooks" under `mcpServers`) is not it.
 */
function rootObjectRange(text: string, key: string): ObjectRange | undefined {
  const clean = uncomment(text);
  const rootOpen = clean.indexOf('{');
  if (rootOpen === -1) return undefined;
  let depth = 0;
  for (let index = rootOpen; index < clean.length; index += 1) {
    const char = clean[index];
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    else if (char === '"') {
      let end = index + 1;
      while (end < clean.length && !(clean[end] === '"' && !isEscaped(clean, end))) end += 1;
      if (depth === 1 && clean.slice(index + 1, end) === key) {
        const value = /^\s*:\s*\{/u.exec(clean.slice(end + 1));
        if (value !== null) {
          const open = end + value[0].length;
          return { key: index, open, close: objectEnd(clean, open, key) };
        }
      }
      index = end;
    }
    if (depth === 0) return undefined;
  }
  return undefined;
}

function parsedObject(text: string): JsonObject {
  const value: unknown = JSON.parse(uncomment(text));
  return objectSchema.parse(value);
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

function directCommas(text: string, range: Pick<ObjectRange, 'open' | 'close'>): number[] {
  const clean = uncomment(text);
  const commas: number[] = [];
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  for (let index = range.open + 1; index < range.close; index += 1) {
    const char = clean[index];
    if (char === '"' && !isEscaped(clean, index)) inString = !inString;
    if (inString) continue;
    if (char === '{') objectDepth += 1;
    else if (char === '}') objectDepth -= 1;
    else if (char === '[') arrayDepth += 1;
    else if (char === ']') arrayDepth -= 1;
    else if (char === ',' && objectDepth === 0 && arrayDepth === 0) commas.push(index);
  }
  return commas;
}

function removeObjectProperty(text: string, parent: ObjectRange, property: ObjectRange): string {
  const commas = directCommas(text, parent);
  const nextComma = commas.find((comma) => comma > property.close);
  if (nextComma !== undefined) return `${text.slice(0, property.key)}${text.slice(nextComma + 1)}`;
  const previousComma = commas.filter((comma) => comma < property.key).at(-1);
  return `${text.slice(0, previousComma ?? property.key)}${text.slice(property.close + 1)}`;
}

export function upsertDevinUserHooksConfig(existing: string | undefined): string {
  const source = existing ?? '{}';
  const config = parsedObject(source);
  const previous = config['hooks'];
  if (
    previous !== undefined &&
    (typeof previous !== 'object' || previous === null || Array.isArray(previous))
  ) {
    throw new Error('Devin config hooks must be an object.');
  }
  const hooks = objectSchema.parse(previous ?? {});
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

  const range = rootObjectRange(source, 'hooks');
  const next = formatNestedObject(
    nextHooks,
    range === undefined ? [] : commentsIn(source.slice(range.open, range.close + 1)),
  );
  if (range !== undefined)
    return `${source.slice(0, range.open)}${next}${source.slice(range.close + 1)}`;
  const clean = uncomment(source);
  const rootOpen = clean.indexOf('{');
  const close = objectEnd(clean, rootOpen, 'root');
  const hasEntries = Object.keys(config).length > 0;
  return `${source.slice(0, close)}${hasEntries ? ',' : ''}\n  "hooks": ${next}\n${source.slice(close)}`;
}

export function removeDevinUserHooksConfig(existing: string): string {
  const config = parsedObject(existing);
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
  const range = rootObjectRange(existing, 'hooks');
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
  return removeObjectProperty(
    existing,
    {
      key: rootOpen,
      open: rootOpen,
      close: objectEnd(clean, rootOpen, 'root'),
    },
    range,
  );
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
    const config = parsedObject(readFileSync(path, 'utf8'));
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
