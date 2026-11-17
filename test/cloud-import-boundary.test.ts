import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runtimeImportGraph(entrypoint: string): Set<string> {
  const visited = new Set<string>();
  const pending = [resolve(repoRoot, entrypoint)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);

    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      )
        continue;
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier)) continue;
      if (specifier.text === 'better-sqlite3') {
        visited.add('package:better-sqlite3');
        continue;
      }
      if (!specifier.text.startsWith('.')) continue;

      let imported = resolve(dirname(file), specifier.text);
      if (imported.endsWith('.js')) imported = `${imported.slice(0, -3)}.ts`;
      if (existsSync(imported)) pending.push(imported);
    }
  }
  return visited;
}

describe('Cloud entrypoint import boundary', () => {
  it.each(['src/index.ts', 'src/cli/cloud-index.ts'])(
    '%s does not import the local SQLite runtime',
    (entrypoint) => {
      const modules = runtimeImportGraph(entrypoint);
      const localSqliteModules = [...modules].filter((file) =>
        /[\\/]db[\\/](?:connection|hermes-session|read-only)\.ts$/u.test(file),
      );

      expect(localSqliteModules).toEqual([]);
      expect(modules.has('package:better-sqlite3')).toBe(false);
      expect([...modules].some((file) => /[\\/]src[\\/]db[\\/]index\.ts$/u.test(file))).toBe(false);
    },
  );
});
