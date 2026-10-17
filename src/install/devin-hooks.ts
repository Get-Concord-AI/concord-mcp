import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { devinMcpConfigPath } from './devin-config.js';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'SessionEnd'] as const;
const objectSchema = z.record(z.string(), z.unknown());

function commandFor(event: (typeof EVENTS)[number]): string {
  return `concord hook devin-${event
    .replace(/([A-Z])/gu, '-$1')
    .toLowerCase()
    .replace(/^-/, '')}`;
}

function entriesForEvent(event: (typeof EVENTS)[number]): unknown[] {
  return [{ matcher: '', hooks: [{ type: 'command', command: commandFor(event) }] }];
}

function uncomment(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (part, quoted: string | undefined) => quoted ?? part.replace(/[^\r\n]/gu, ' '),
  );
}

function objectRange(text: string, key: string): { open: number; close: number } | undefined {
  const clean = uncomment(text);
  const match = new RegExp(`"${key}"\\s*:\\s*\\{`, 'u').exec(clean);
  if (match === null) return undefined;
  const open = match.index + match[0].lastIndexOf('{');
  let depth = 0;
  let inString = false;
  for (let index = open; index < clean.length; index += 1) {
    const char = clean[index];
    if (char === '"' && clean[index - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return { open, close: index };
  }
  throw new Error(`Unclosed ${key} object`);
}

function parsedObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(uncomment(text));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Devin config must contain a JSON object.');
  }
  return objectSchema.parse(value);
}

function formatNestedObject(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
}

function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(devinMcpConfigPath(env)), 'config.json');
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
    const current = z.array(z.unknown()).safeParse(hooks[event]);
    const entries = current.success ? current.data : [];
    const command = commandFor(event);
    if (!entries.some((entry) => JSON.stringify(entry).includes(command))) {
      nextHooks[event] = [...entries, ...entriesForEvent(event)];
    }
  }
  if (JSON.stringify(nextHooks) === JSON.stringify(hooks)) return source;

  const range = objectRange(source, 'hooks');
  const next = formatNestedObject(nextHooks);
  if (range !== undefined)
    return `${source.slice(0, range.open)}${next}${source.slice(range.close + 1)}`;
  const rootClose = objectRange(source, '__concord_missing__');
  const clean = uncomment(source);
  const close = rootClose?.close ?? clean.lastIndexOf('}');
  if (close < 0) throw new Error('Devin config must contain a JSON object.');
  const hasEntries = Object.keys(config).length > 0;
  const formatted = formatNestedObject(nextHooks);
  return `${source.slice(0, close)}${hasEntries ? ',' : ''}\n  "hooks": ${formatted}\n${source.slice(close)}`;
}

export function removeDevinUserHooksConfig(existing: string): string {
  const config = parsedObject(existing);
  const current: unknown = config['hooks'];
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return existing;
  const hooks = objectSchema.parse(current);
  const nextHooks = { ...hooks };
  let changed = false;
  for (const event of EVENTS) {
    const entries: unknown = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !JSON.stringify(entry).includes('concord hook devin-'));
    if (kept.length !== entries.length) {
      changed = true;
      if (kept.length === 0) Reflect.deleteProperty(nextHooks, event);
      else nextHooks[event] = kept;
    }
  }
  if (!changed) return existing;
  const range = objectRange(existing, 'hooks');
  if (range === undefined) return existing;
  if (Object.keys(nextHooks).length > 0) {
    const formatted = formatNestedObject(nextHooks);
    return `${existing.slice(0, range.open)}${formatted}${existing.slice(range.close + 1)}`;
  }
  const clean = uncomment(existing);
  let start = clean.lastIndexOf('"hooks"', range.open);
  let end = range.close + 1;
  let after = end;
  while (/\s/u.test(clean[after] ?? '')) after += 1;
  if (clean[after] === ',') end = after + 1;
  else {
    let before = start - 1;
    while (/\s/u.test(clean[before] ?? '')) before -= 1;
    if (clean[before] === ',') start = before;
  }
  return `${existing.slice(0, start)}${existing.slice(end)}`;
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

export function installDevinHooks(repoRoot: string): string {
  const relative = join('.devin', 'hooks.v1.json');
  const path = join(repoRoot, relative);
  const current: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new Error(`${relative} must contain a JSON object.`);
  }
  const hooks = { ...current };
  for (const event of EVENTS) {
    const hook = { type: 'command', command: commandFor(event) };
    const values: unknown = Reflect.get(hooks, event);
    const parsed = z.array(z.unknown()).safeParse(values);
    const entries = parsed.success ? parsed.data : [];
    if (!entries.some((entry) => JSON.stringify(entry).includes(hook.command))) {
      Reflect.set(hooks, event, [...entries, { matcher: '', hooks: [hook] }]);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(hooks, null, 2)}\n`);
  return relative;
}

export function removeDevinHooks(repoRoot: string): string | undefined {
  const relative = join('.devin', 'hooks.v1.json');
  const path = join(repoRoot, relative);
  if (!existsSync(path)) return undefined;
  const hooks: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return undefined;
  let changed = false;
  for (const event of EVENTS) {
    const entries: unknown = Reflect.get(hooks, event);
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !JSON.stringify(entry).includes('concord hook devin-'));
    if (kept.length !== entries.length) {
      changed = true;
      Reflect.set(hooks, event, kept);
    }
  }
  if (!changed) return undefined;
  writeFileSync(path, `${JSON.stringify(hooks, null, 2)}\n`);
  return relative;
}
