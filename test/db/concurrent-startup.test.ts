import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type ConcordDatabase } from '../../src/db/connection.js';
import { migrations } from '../../src/db/schema.js';

const OPENERS = 8;

const tempDirs: string[] = [];
const openDbs: ConcordDatabase[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Lets a plain `node` child import this repo's TypeScript sources: types are
// stripped, and the `.js` specifiers the sources use are mapped to `.ts`.
const RESOLVE_TS = [
  'export async function resolve(specifier, context, next) {',
  '  try { return await next(specifier, context); } catch (error) {',
  "    if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "      return next(specifier.slice(0, -3) + '.ts', context);",
  '    }',
  '    throw error;',
  '  }',
  '}',
].join('\n');
const REGISTER_HOOK = `data:text/javascript,${encodeURIComponent(
  "import { register } from 'node:module';\n" +
    `register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(RESOLVE_TS)}`)});`,
)}`;
const CONNECTION_URL = pathToFileURL(join(import.meta.dirname, '../../src/db/connection.ts')).href;

/** Open `file` from a separate process at `startAt`, resolving with its exit code and output. */
function openInChild(
  file: string,
  startAt: number,
): Promise<{ code: number | null; output: string }> {
  const script = [
    `import { openDatabase } from ${JSON.stringify(CONNECTION_URL)};`,
    `while (Date.now() < ${String(startAt)}) {}`,
    `const db = openDatabase(${JSON.stringify(file)});`,
    "process.stdout.write(String(db.pragma('user_version', { simple: true })));",
    'db.close();',
  ].join('\n');
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--import',
        REGISTER_HOOK,
        '--input-type=module',
        '-e',
        script,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => {
      done({ code, output });
    });
  });
}

describe('opening a brand-new store from several processes', () => {
  it('every open succeeds at the final schema version and the store stays usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-startup-'));
    tempDirs.push(dir);
    const file = join(dir, 'concord.db');
    // Every child waits for the same moment, so the opens race instead of queueing.
    const startAt = Date.now() + 2000;
    const results = await Promise.all(
      Array.from({ length: OPENERS }, () => openInChild(file, startAt)),
    );

    const version = String(migrations.length);
    expect(results).toEqual(Array.from({ length: OPENERS }, () => ({ code: 0, output: version })));
    // A later open still works and sees the final schema.
    const later = openDatabase(file);
    openDbs.push(later);
    expect(later.pragma('user_version', { simple: true })).toBe(migrations.length);
  }, 30_000);
});
