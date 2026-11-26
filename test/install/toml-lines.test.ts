import { describe, expect, it } from 'vitest';

import {
  inlineTableKeys,
  tomlAssignment,
  tomlHeader,
  tomlKeyParts,
  tomlKeyPath,
  tomlLines,
} from '../../src/install/toml-lines.js';

function insideStrings(source: string): string[] {
  return [...tomlLines(source)].filter((line) => line.inString).map((line) => line.text);
}

describe('tomlLines', () => {
  it('marks the inside of multi-line strings, and nothing else', () => {
    expect(insideStrings('a = """\n[x]\nb = 1\n"""\n[y]')).toEqual(['[x]', 'b = 1', '"""']);
    expect(insideStrings("a = '''one'''\nb = '''\n[x]\n'''")).toEqual(['[x]', "'''"]);
    expect(insideStrings('a = """ends with a quote""""\n[x]')).toEqual([]);
    expect(insideStrings('a = """\nescaped \\"""\n"""\n[x]')).toEqual(['escaped \\"""', '"""']);
  });

  it('reads triple quotes inside single-line strings and comments as text', () => {
    for (const line of [`a = '"""'`, `a = "'''"`, 'a = "\\"\\"\\""', '# """', "a = 1 # '''"]) {
      expect(insideStrings(`${line}\n[x]`)).toEqual([]);
    }
  });
});

describe('inlineTableKeys', () => {
  it('lists only the top-level keys of an inline table', () => {
    expect(inlineTableKeys(' { a = 1, "b" . c = { d = 2 }, e = [1, { f = 3 }] }')).toEqual([
      'a',
      'b.c',
      'e',
    ]);
    expect(inlineTableKeys(' { a = "x = 1, y = 2" }')).toEqual(['a']);
    expect(inlineTableKeys(' "{ a = 1 }"')).toEqual([]);
  });
});

describe('tomlKeyPath', () => {
  it('spells a key one way, keeping a quoted dot inside its part', () => {
    expect(tomlKeyPath(` mcp_servers . "concord" `)).toBe('mcp_servers.concord');
    expect(tomlKeyPath(`mcp_servers.'concord'.env`)).toBe('mcp_servers.concord.env');
    expect(tomlKeyPath('mcp_servers."concord.env"')).toBe('mcp_servers."concord.env"');
    expect(tomlKeyPath('"my server"')).toBe('"my server"');
  });

  it('decodes TOML basic-string escapes in quoted keys', () => {
    expect(tomlKeyPath('"mcp_\\u0073ervers"')).toBe('mcp_servers');
    expect(tomlKeyPath('mcp_servers."e\\u006ev"')).toBe('mcp_servers.env');
    expect(tomlKeyParts('"\\U0001F600"')).toEqual(['😀']);
  });

  it('does not decode escapes in literal keys or invalid basic-string escapes', () => {
    expect(tomlKeyParts(`'mcp_\\u0073ervers'`)).toEqual(['mcp_\\u0073ervers']);
    expect(tomlKeyParts('"mcp_\\qservers"')).toEqual(['mcp_\\qservers']);
    expect(tomlKeyParts('"mcp_\\uD800ervers"')).toEqual(['mcp_\\uD800ervers']);
  });
});

describe('tomlHeader', () => {
  it('reads array and table headers with decoded key paths', () => {
    expect(tomlHeader('  [[mcp_servers]] # servers')).toMatchObject({
      array: true,
      parts: ['mcp_servers'],
      path: 'mcp_servers',
    });
    expect(tomlHeader('[mcp_servers."e\\u006ev"]')).toMatchObject({
      array: false,
      parts: ['mcp_servers', 'env'],
      path: 'mcp_servers.env',
    });
  });

  it('rejects incomplete headers and trailing junk', () => {
    expect(tomlHeader('[mcp_servers.env] trailing')).toBeUndefined();
    expect(tomlHeader('[[ ]]')).toBeUndefined();
  });
});

describe('tomlAssignment', () => {
  it('reads assignments with decoded quoted keys', () => {
    const assignment = tomlAssignment(' "mcp_\\u0073ervers" = [] # servers');
    expect(assignment?.parts).toEqual(['mcp_servers']);
    expect(assignment?.path).toBe('mcp_servers');
    expect(assignment?.value).toBe('[] # servers');
  });

  it('finds the separator outside quoted keys only', () => {
    const assignment = tomlAssignment('"a=b" = 1');
    expect(assignment?.parts).toEqual(['a=b']);
    expect(assignment?.value).toBe('1');
    expect(tomlAssignment('# comment = 1')).toBeUndefined();
  });
});
