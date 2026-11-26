/**
 * Just enough TOML lexing to edit a config line by line without a parser:
 * which lines are inside a multi-line string, and which keys a line holds.
 */

type MultilineQuote = '"""' | "'''";

/** One line of TOML source; `inString` lines continue a multi-line string and hold no TOML. */
export interface TomlLine {
  readonly text: string;
  readonly inString: boolean;
}

/** A `[table]` or `[[table]]` header, with its key parts decoded. */
export interface TomlHeader {
  readonly parts: readonly string[];
  readonly path: string;
  readonly array: boolean;
}

/** A `key = value` line, with the key parts decoded and the value text trimmed. */
export interface TomlAssignment {
  readonly parts: readonly string[];
  readonly path: string;
  readonly value: string;
}

const SIMPLE_KEY_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['b', '\b'],
  ['t', '\t'],
  ['n', '\n'],
  ['f', '\f'],
  ['r', '\r'],
  ['"', '"'],
  ['\\', '\\'],
]);

/**
 * Decode the escapes TOML allows in a basic string. Invalid escapes stay
 * literal: a malformed value must never collapse into a name Concord protects.
 */
export function decodeTomlBasicString(part: string): string {
  let decoded = '';
  let index = 0;
  while (index < part.length) {
    const char = part[index];
    if (char !== '\\') {
      decoded += char ?? '';
      index += 1;
      continue;
    }
    const escape = part[index + 1];
    if (escape === undefined) {
      decoded += char;
      index += 1;
      continue;
    }
    const simple = SIMPLE_KEY_ESCAPES.get(escape);
    if (simple !== undefined) {
      decoded += simple;
      index += 2;
      continue;
    }
    if (escape === 'u' || escape === 'U') {
      const length = escape === 'u' ? 4 : 8;
      const hex = part.slice(index + 2, index + 2 + length);
      const hexPattern = length === 4 ? /^[0-9A-Fa-f]{4}$/u : /^[0-9A-Fa-f]{8}$/u;
      if (hexPattern.test(hex)) {
        const codepoint = Number.parseInt(hex, 16);
        const surrogate = codepoint >= 0xd800 && codepoint <= 0xdfff;
        if (codepoint <= 0x10ffff && !surrogate) {
          decoded += String.fromCodePoint(codepoint);
          index += 2 + length;
          continue;
        }
      }
    }
    decoded += char;
    index += 1;
  }
  return decoded;
}

/**
 * The parts of a TOML key path. Quoted basic keys have their escapes decoded;
 * literal keys (single quotes) do not. Whitespace around dots is ignored, as
 * before. Invalid syntax is retained as faithfully as possible rather than
 * throwing, because callers use this conservatively to decide what not to touch.
 */
export function tomlKeyParts(raw: string): string[] {
  const parts: string[] = [];
  let part = '';
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '"' || char === "'") {
      const end = singleLineStringEnd(raw, index);
      const closed = end > index + 1 && raw[end - 1] === char;
      const bodyEnd = closed ? end - 1 : end;
      const body = raw.slice(index + 1, bodyEnd);
      part += char === '"' ? decodeTomlBasicString(body) : body;
      index = end;
      continue;
    }
    if (char === '.') {
      parts.push(part);
      part = '';
    } else if (char !== undefined && !/\s/u.test(char)) {
      part += char;
    }
    index += 1;
  }
  parts.push(part);
  return parts;
}

function canonicalKeyPath(parts: readonly string[]): string {
  return parts.map((key) => (/^[\w-]+$/u.test(key) ? key : JSON.stringify(key))).join('.');
}

/**
 * A TOML key path in one spelling: `mcp_servers . "concord"` → `mcp_servers.concord`. A part
 * that is not a bare key stays quoted, so `"concord.env"` remains one part, not two.
 */
export function tomlKeyPath(raw: string): string {
  return canonicalKeyPath(tomlKeyParts(raw));
}

function closedQuoteEnd(text: string, start: number): number | undefined {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index + 1;
  }
  return undefined;
}

/**
 * The header a line opens, or undefined when it is not a complete TOML header.
 * Closing brackets inside quoted keys do not count, and quoted keys must be
 * closed before the header's own bracket can end the line.
 */
export function tomlHeader(text: string): TomlHeader | undefined {
  let index = 0;
  while (index < text.length && /\s/u.test(text[index] ?? '')) index += 1;

  let array = false;
  if (text.startsWith('[[', index)) {
    array = true;
    index += 2;
  } else if (text[index] === '[') {
    index += 1;
  } else {
    return undefined;
  }

  const keyStart = index;
  let close = -1;
  while (index < text.length) {
    const char = text[index];
    if (char === '#') return undefined;
    if (char === '"' || char === "'") {
      const end = closedQuoteEnd(text, index);
      if (end === undefined) return undefined;
      index = end;
      continue;
    }
    if (char === ']') {
      if (array) {
        if (text[index + 1] !== ']') return undefined;
        close = index;
        index += 2;
      } else {
        close = index;
        index += 1;
      }
      break;
    }
    index += 1;
  }
  if (close < 0 || !/^\s*(?:#.*)?$/u.test(text.slice(index))) return undefined;

  const raw = text.slice(keyStart, close).trim();
  if (raw === '') return undefined;
  const parts = tomlKeyParts(raw);
  return { parts, path: canonicalKeyPath(parts), array };
}

/** The assignment a line makes, with `=` found outside quoted key parts. */
export function tomlAssignment(text: string): TomlAssignment | undefined {
  let separator: number | undefined;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '#') return undefined;
    if (char === '=') {
      separator = index;
      break;
    }
    if (char === '"' || char === "'") {
      index = singleLineStringEnd(text, index);
      continue;
    }
    index += 1;
  }
  if (separator === undefined) return undefined;
  const key = text.slice(0, separator);
  if (key.trim() === '') return undefined;
  const parts = tomlKeyParts(key);
  return {
    parts,
    path: canonicalKeyPath(parts),
    value: text.slice(separator + 1).trim(),
  };
}

function multilineQuoteAt(text: string, index: number): MultilineQuote | undefined {
  if (text.startsWith('"""', index)) return '"""';
  if (text.startsWith("'''", index)) return "'''";
  return undefined;
}

/** The index just past a single-line string opening at `start`, or the line's end if unclosed. */
function singleLineStringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') index += 1;
    else if (text[index] === quote) return index + 1;
  }
  return text.length;
}

/** The multi-line string still open after `text`, given the one open before it. */
function openStringAfter(
  text: string,
  open: MultilineQuote | undefined,
): MultilineQuote | undefined {
  let quote = open;
  let index = 0;
  while (index < text.length) {
    if (quote !== undefined) {
      if (quote === '"""' && text[index] === '\\') {
        index += 2;
      } else if (text.startsWith(quote, index)) {
        // Up to two more quotes may end the string's content.
        const mark = quote[0];
        index += 3;
        while (text[index] === mark) index += 1;
        quote = undefined;
      } else {
        index += 1;
      }
      continue;
    }
    const char = text[index];
    if (char === '#') break;
    const opening = multilineQuoteAt(text, index);
    if (opening !== undefined) {
      quote = opening;
      index += 3;
    } else if (char === '"' || char === "'") {
      index = singleLineStringEnd(text, index);
    } else {
      index += 1;
    }
  }
  return quote;
}

/** Each line of `source`, marked when it is the inside of a multi-line string. */
export function* tomlLines(source: string): Generator<TomlLine> {
  let open: MultilineQuote | undefined;
  for (const text of source.split(/\r?\n/u)) {
    yield { text, inString: open !== undefined };
    open = openStringAfter(text, open);
  }
}

/** The key paths an inline table value (`{ a = 1, b.c = { d = 2 } }`) sets at its top level. */
export function inlineTableKeys(value: string): string[] {
  const keys: string[] = [];
  if (!value.trimStart().startsWith('{')) return keys;
  let depth = 0;
  let keyStart: number | undefined;
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === '"' || char === "'") {
      index = singleLineStringEnd(value, index);
      continue;
    }
    if (char === '#') break;
    if (char === '{' || char === '[') {
      depth += 1;
      if (depth === 1) keyStart = index + 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) break;
    } else if (char === ',' && depth === 1) {
      keyStart = index + 1;
    } else if (char === '=' && depth === 1 && keyStart !== undefined) {
      keys.push(tomlKeyPath(value.slice(keyStart, index)));
      keyStart = undefined;
    }
    index += 1;
  }
  return keys;
}
