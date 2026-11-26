import { describe, expect, it } from 'vitest';

import {
  directCommas,
  isJsonObject,
  objectEnd,
  parseJsoncObject,
  propertyObject,
  removeProperty,
  uncomment,
} from '../../src/install/jsonc-edit.js';

describe('uncomment', () => {
  it('blanks comments while preserving strings and length', () => {
    const text = '{ "a": "https://x.test", /* mid */ "b": 1 } // tail';
    const clean = uncomment(text);
    expect(clean).toHaveLength(text.length);
    expect(clean).toContain('"https://x.test"');
    expect(clean).not.toContain('tail');
    expect(clean).not.toContain('mid');
  });

  it('keeps the length when a comment holds characters outside the BMP', () => {
    const text = '/* 😀 */ { "a": 1 } // 🚀 tail';
    expect(uncomment(text)).toHaveLength(text.length);
  });
});

describe('parseJsoncObject', () => {
  it('parses objects with comments and rejects non-objects', () => {
    expect(parseJsoncObject('{ // c\n "a": 1 }')).toEqual({ a: 1 });
    expect(() => parseJsoncObject('[1,2]')).toThrow();
  });
});

describe('isJsonObject', () => {
  it('accepts plain objects only', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([1])).toBe(false);
    expect(isJsonObject('x')).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});

describe('propertyObject', () => {
  it('locates a direct child "key": {…} span by index', () => {
    const text = '{\n  "mcp": {\n    // inner\n    "concord": { "command": "concord-mcp" }\n  }\n}';
    const mcp = propertyObject(text, 'mcp');
    if (mcp === undefined) throw new Error('expected mcp');
    const slice = text.slice(mcp.open, mcp.close + 1);
    const range = propertyObject(slice, 'concord');
    if (range === undefined) throw new Error('expected a range');
    expect(slice.slice(range.key, range.key + 9)).toBe('"concord"');
    expect(slice[range.open]).toBe('{');
    expect(slice[range.close]).toBe('}');
    expect(propertyObject(text, 'missing')).toBeUndefined();
  });

  it('ignores a nested key of the same name', () => {
    const text = '{"other":{"options":{"concord":{"x":1}}},"concord":{"y":2}}';
    const range = propertyObject(text, 'concord');
    if (range === undefined) throw new Error('expected a range');
    expect(text.slice(range.open, range.close + 1)).toBe('{"y":2}');
    expect(propertyObject('{"other":{"concord":{}}}', 'concord')).toBeUndefined();
  });
});

describe('objectEnd', () => {
  it('returns the index of the matching close brace', () => {
    const text = '{ "a": { "b": [1, {"c": 2}] }, "d": 3 }';
    expect(text[objectEnd(text, 0)]).toBe('}');
    expect(() => objectEnd('{ "a": 1', 0)).toThrow('Unclosed JSON object');
  });
});

describe('directCommas', () => {
  it('finds only commas at the parent depth', () => {
    const text = '{ "a": {"x":1,"y":2}, "b": [1,2], "c": 3 }';
    const root = { open: text.indexOf('{'), close: text.lastIndexOf('}') };
    const commas = directCommas(text, root);
    // commas after "a" object and after "b" array — not the nested ones
    expect(commas).toHaveLength(2);
  });
});

describe('removeProperty', () => {
  function span(text: string, key: string) {
    const found = propertyObject(text, key);
    if (found === undefined) throw new Error(`missing ${key}`);
    return found;
  }

  it('removes a middle property and keeps its trailing comment', () => {
    const text = '{\n  "a": 1,\n  "b": { "x": 1 }, // keep me\n  "c": 3\n}';
    const rootClose = objectEnd(text, 0);
    const result = removeProperty(text, { open: 0, close: rootClose }, span(text, 'b'));
    expect(result).toContain('"a": 1');
    expect(result).toContain('"c": 3');
    expect(result).not.toContain('"b"');
    expect(result).toContain('// keep me');
    expect(() => parseJsoncObject(result)).not.toThrow();
  });

  it('keeps a comment sitting between the closing brace and the comma', () => {
    const text = '{\n  "a": 1,\n  "b": {} /* keep me */,\n  "c": 3\n}';
    const result = removeProperty(text, { open: 0, close: objectEnd(text, 0) }, span(text, 'b'));
    expect(result).toContain('"a": 1');
    expect(result).toContain('"c": 3');
    expect(result).not.toContain('"b"');
    expect(result).toContain('/* keep me */');
    expect(() => parseJsoncObject(result)).not.toThrow();
  });

  it('removes the last property via the previous comma', () => {
    const text = '{\n  "a": 1,\n  "b": { "x": 1 }\n}';
    const result = removeProperty(text, { open: 0, close: objectEnd(text, 0) }, span(text, 'b'));
    expect(result).toContain('"a": 1');
    expect(result).not.toContain('"b"');
    expect(() => parseJsoncObject(result)).not.toThrow();
  });

  it('removes the only property leaving an empty object', () => {
    const text = '{\n  "b": { "x": 1 }\n}';
    const result = removeProperty(text, { open: 0, close: objectEnd(text, 0) }, span(text, 'b'));
    expect(result).not.toContain('"b"');
    expect(() => parseJsoncObject(result)).not.toThrow();
  });
});

describe('removeProperty orphan comments', () => {
  function span(text: string, key: string) {
    const found = propertyObject(text, key);
    if (found === undefined) throw new Error(`missing ${key}`);
    return found;
  }

  it('keeps a leading comment with its original whitespace when removing the last property', () => {
    const text = `{
  "a": 1,
  // section note
  "b": { "x": 2 }
}
`;
    const result = removeProperty(text, { open: 0, close: objectEnd(text, 0) }, span(text, 'b'));
    expect(result).toBe(`{
  "a": 1
  // section note
}
`);
    expect(() => parseJsoncObject(result)).not.toThrow();
  });

  it('keeps leading comment whitespace with CRLF line endings', () => {
    const text = '{\r\n  "a": 1,\r\n  // section note\r\n  "b": { "x": 2 }\r\n}\r\n';
    const result = removeProperty(text, { open: 0, close: objectEnd(text, 0) }, span(text, 'b'));
    expect(result).toBe('{\r\n  "a": 1\r\n  // section note\r\n}\r\n');
    expect(() => parseJsoncObject(result)).not.toThrow();
  });

  it('keeps a retained line comment terminated when the parent closes on the same line', () => {
    const text = '{ "a": {}, // note\n "b": {}}';
    const result = removeProperty(text, { open: 0, close: objectEnd(text, 0) }, span(text, 'b'));
    expect(result).toBe('{ "a": {} // note\n}');
    expect(() => parseJsoncObject(result)).not.toThrow();
  });
});
