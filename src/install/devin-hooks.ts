import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'SessionEnd'] as const;
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

interface DevinCommandHook extends JsonObject {
  type: 'command';
  command: string;
}

interface DevinHookEntry extends JsonObject {
  matcher: string;
  hooks: DevinCommandHook[];
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

function commandFor(event: (typeof EVENTS)[number]): string {
  return `concord hook devin-${event
    .replace(/([A-Z])/gu, '-$1')
    .toLowerCase()
    .replace(/^-/, '')}`;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const kept = hooks.filter(
    (hook) =>
      !(
        isJsonObject(hook) &&
        hook['type'] === 'command' &&
        typeof hook['command'] === 'string' &&
        hook['command'].startsWith('concord hook devin-')
      ),
  );
  if (kept.length === hooks.length) return { value: entry, changed: false };
  return { value: kept.length === 0 ? undefined : { ...entry, hooks: kept }, changed: true };
}

export function installDevinHooks(repoRoot: string): string {
  const relative = join('.devin', 'hooks.v1.json');
  const path = join(repoRoot, relative);
  const current = existsSync(path)
    ? jsonValueSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    : {};
  if (!isJsonObject(current)) throw new Error(`${relative} must contain a JSON object.`);
  const hooks: JsonObject = { ...current };
  for (const event of EVENTS) {
    const values = hooks[event];
    const entries = Array.isArray(values) ? values : [];
    const command = commandFor(event);
    if (!entries.some((entry) => entryContainsCommand(entry, command))) {
      const generated: DevinHookEntry = {
        matcher: '',
        hooks: [{ type: 'command', command }],
      };
      hooks[event] = [...entries, generated];
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
  const parsed = jsonValueSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (!isJsonObject(parsed)) return undefined;
  const hooks: JsonObject = { ...parsed };
  let changed = false;
  for (const event of EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const results = entries.map(removeConcordCommands);
    if (!results.some((result) => result.changed)) continue;
    changed = true;
    const kept = results.flatMap((result) => (result.value === undefined ? [] : [result.value]));
    if (kept.length === 0) Reflect.deleteProperty(hooks, event);
    else hooks[event] = kept;
  }
  if (!changed) return undefined;
  writeFileSync(path, `${JSON.stringify(hooks, null, 2)}\n`);
  return relative;
}
