import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const pluginSpawner = pathToFileURL(resolve('plugin/spawn-command.mjs')).href;

function pluginEval(expression: string, file: string, args: readonly string[]): string {
  const source = `import { batchCommandLine, quoteCmdArgument } from ${JSON.stringify(pluginSpawner)};
const file = process.env.SPAWN_FILE ?? '';
const args = JSON.parse(process.env.SPAWN_ARGS ?? '[]');
process.stdout.write(JSON.stringify(${expression}));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    env: { ...process.env, SPAWN_FILE: file, SPAWN_ARGS: JSON.stringify(args) },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('plugin spawn-command', () => {
  it('quotes a batch program path with spaces separately from its arguments', () => {
    const file = 'C:\\Program Files\\concord\\concord.cmd';
    expect(pluginEval('batchCommandLine(file, args)', file, ['inbox', 'register'])).toBe(
      JSON.stringify('""C:\\Program Files\\concord\\concord.cmd" inbox register"'),
    );
  });

  it('quotes empty arguments, quotes, percent signs, and metacharacters', () => {
    const values = ['', 'say "hi"', '100%', 'a&b', 'plain'];
    expect(pluginEval('args.map((arg) => quoteCmdArgument(arg))', '', values)).toBe(
      JSON.stringify(['""', '"say ""hi"""', '"100%%"', '"a&b"', 'plain']),
    );
  });

  it('spawns a non-batch override directly without a shell', () => {
    const source = `import { spawnCommandSync } from ${JSON.stringify(pluginSpawner)};
const result = spawnCommandSync(process.execPath, ['-e', 'process.stdout.write("a b&c")'], { encoding: 'utf8' });
process.stdout.write(result.stdout);
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
    });
    expect(result.stdout, result.stderr).toBe('a b&c');
  });
});
