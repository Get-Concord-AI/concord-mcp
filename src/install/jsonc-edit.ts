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
    (part, quoted: string | undefined) => quoted ?? part.replace(/[^\r\n]/gu, ' '),
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

export function propertyObject(text: string, key: string): ObjectRange | undefined {
  const clean = uncomment(text);
  const match = new RegExp(`"${key}"\\s*:\\s*\\{`, 'u').exec(clean);
  if (match === null) return undefined;
  const open = match.index + match[0].lastIndexOf('{');
  return { key: match.index, open, close: objectEnd(clean, open) };
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
  return `${text.slice(0, start)}${text.slice(property.close + 1)}`;
}
