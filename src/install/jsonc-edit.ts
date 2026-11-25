import { jsonObjectSchema, type JsonObject, type JsonValue } from './json-value.js';

/**
 * Shared JSONC text helpers: they locate and splice `"key": {…}` properties in a
 * config file while preserving the user's comments, formatting and key order.
 * `uncomment` is length-preserving, so indexes computed on the stripped text
 * stay valid against the original.
 */

export function uncomment(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    // One space per UTF-16 unit, so an emoji in a comment keeps every later index.
    (part, quoted: string | undefined) =>
      quoted ?? part.replace(/[^\r\n]/gu, (char) => ' '.repeat(char.length)),
  );
}

export function parseJsoncObject(text: string): JsonObject {
  const value: unknown = JSON.parse(uncomment(text));
  return jsonObjectSchema.parse(value);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

export function objectEnd(text: string, open: number): number {
  const clean = uncomment(text);
  let depth = 0;
  let inString = false;
  for (let index = open; index < clean.length; index += 1) {
    const char = clean[index];
    if (char === '"' && !isEscaped(clean, index)) inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return index;
  }
  throw new Error('Unclosed JSON object');
}

export interface ObjectRange {
  key: number;
  open: number;
  close: number;
}

/**
 * The object value of `key` directly inside the first object in `text`. A key
 * of the same name nested deeper (say a server named "hooks" under
 * `mcpServers`, or a `concord` key inside another server's options) is not it.
 */
export function propertyObject(text: string, key: string): ObjectRange | undefined {
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
          return { key: index, open, close: objectEnd(clean, open) };
        }
      }
      index = end;
    }
    if (depth === 0) return undefined;
  }
  return undefined;
}

export function directCommas(text: string, range: Pick<ObjectRange, 'open' | 'close'>): number[] {
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

export function removeProperty(
  text: string,
  parent: Pick<ObjectRange, 'open' | 'close'>,
  property: Pick<ObjectRange, 'key' | 'close'>,
): string {
  const clean = uncomment(text);
  const commas = directCommas(clean, parent);
  const nextComma = commas.find((comma) => comma > property.close);
  if (nextComma !== undefined) {
    const between = text.slice(property.close + 1, nextComma);
    const comments = between.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu) ?? [];
    const retained = comments.length === 0 ? '' : `\n${comments.join('\n')}\n`;
    return `${text.slice(0, property.key)}${retained}${text.slice(nextComma + 1)}`;
  }
  const previousComma = commas.filter((comma) => comma < property.key).at(-1);
  const start = previousComma ?? property.key;
  // Comments leading the property — a section note between the preceding
  // comma and the key — are not part of the value being removed: keep them,
  // the way comments after a middle property are kept.
  const lead = text.slice(start, property.key);
  const leadComments = lead.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu) ?? [];
  const retained = leadComments.length === 0 ? '' : `${leadComments.join('\n')}\n`;
  return `${text.slice(0, start)}${retained}${text.slice(property.close + 1)}`;
}
