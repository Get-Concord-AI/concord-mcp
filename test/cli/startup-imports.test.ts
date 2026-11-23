import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

/** Value imports and re-exports; `import type` lines are skipped by the second group. */
const IMPORT_PATTERN = /^(?:import|export)(\s+type)?\s[^;]*?from\s+['"]([^'"]+)['"]/gmsu;

/**
 * Packages that cost hundreds of milliseconds to load. Agent hooks start the
 * CLI on every tool call, so the paths they take must not import these.
 */
const HEAVY_PACKAGES = ['ink', 'react', '@modelcontextprotocol/sdk'];

interface StaticImports {
  files: string[];
  packages: string[];
}

function staticImports(file: string): StaticImports {
  const imports: StaticImports = { files: [], packages: [] };
  for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_PATTERN)) {
    const [, typeOnly, specifier] = match;
    if (typeOnly !== undefined || specifier === undefined) continue;
    if (specifier.startsWith('.')) {
      const base = resolve(dirname(file), specifier).replace(/\.js$/u, '');
      const target = [`${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate));
      if (target !== undefined) imports.files.push(target);
    } else if (!specifier.startsWith('node:')) {
      imports.packages.push(specifier);
    }
  }
  return imports;
}

/** Each heavy package statically reachable from `entry`, with the import chain to it. */
function heavyImports(entry: string): string[] {
  const parents = new Map<string, string>();
  const seen = new Set<string>();
  const queue = [join(SRC, entry)];
  const found: string[] = [];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const { files, packages } = staticImports(file);
    for (const name of packages) {
      if (!HEAVY_PACKAGES.some((heavy) => name === heavy || name.startsWith(`${heavy}/`))) continue;
      const chain: string[] = [];
      for (let at: string | undefined = file; at !== undefined; at = parents.get(at)) {
        chain.push(at.slice(SRC.length + 1));
      }
      found.push(`${name} via ${chain.join(' <- ')}`);
    }
    for (const next of files) {
      if (!seen.has(next) && !parents.has(next)) parents.set(next, file);
      queue.push(next);
    }
  }
  return found;
}

describe('CLI startup imports', () => {
  it('defines commands without importing any command module up front', () => {
    expect(staticImports(join(SRC, 'cli/run.ts')).files).not.toContainEqual(
      expect.stringContaining(join('cli', 'commands')),
    );
    expect(heavyImports('cli/run.ts')).toEqual([]);
  });

  it.each(['hook', 'inbox', 'check'])('keeps the %s command off Ink and the MCP SDK', (name) => {
    expect(heavyImports(`cli/commands/${name}.ts`)).toEqual([]);
  });

  it('still sees the heavy imports it guards against', () => {
    expect(heavyImports('cli/commands/dashboard.tsx')).toContainEqual(
      expect.stringMatching(/^ink via /u),
    );
  });
});
