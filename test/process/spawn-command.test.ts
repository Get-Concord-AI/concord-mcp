import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  batchCommandLine,
  quoteCmdArgument,
  spawnCommandSync,
} from '../../src/process/spawn-command.js';

const pluginSpawner = join(process.cwd(), 'plugin', 'spawn-command.mjs');

describe('batch command lines', () => {
  it('quotes a program path separately from its arguments', () => {
    expect(batchCommandLine('D:\\Program Files (x86)\\cursor.cmd', ['--version'])).toBe(
      '""D:\\Program Files (x86)\\cursor.cmd" --version"',
    );
    expect(quoteCmdArgument('--version')).toBe('--version');
  });

  it('quotes empty arguments, quotes, percent signs, and metacharacters', () => {
    expect(quoteCmdArgument('')).toBe('""');
    expect(quoteCmdArgument('say "hi"')).toBe('"say ""hi"""');
    expect(quoteCmdArgument('100%')).toBe('"100%%"');
    expect(quoteCmdArgument('a&b')).toBe('"a&b"');
    expect(batchCommandLine('C:\\npm\\codex.cmd', ['--version'])).toBe(
      '"C:\\npm\\codex.cmd --version"',
    );
  });

  it('keeps the plugin spawner on the same command line', () => {
    const file = 'D:\\Program Files (x86)\\cursor.cmd';
    const args = ['--version', '100%', 'a b'];
    expect(pluginBatchCommandLine(pluginSpawner, file, args)).toBe(batchCommandLine(file, args));
  });
});

describe('spawnCommandSync', () => {
  it('runs an executable directly', () => {
    const result = spawnCommandSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it.skipIf(process.platform !== 'win32')(
    'runs a batch file whose directory name contains spaces',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'concord-spawn-'));
      const bin = join(root, 'Program Files');
      mkdirSync(bin);
      const reader = join(root, 'read-stdin.mjs');
      writeFileSync(
        reader,
        [
          'let text = "";',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (chunk) => {',
          '  text += chunk;',
          '});',
          'process.stdin.on("end", () => {',
          '  process.stdout.write(`STDIN:${text}\\nARGS:${process.argv.slice(2).join("|")}`);',
          '});',
          '',
        ].join('\n'),
      );
      writeFileSync(join(bin, 'tool.cmd'), `@echo off\r\n"${process.execPath}" "${reader}" %*\r\n`);

      const result = spawnCommandSync('tool', ['--version'], {
        encoding: 'utf8',
        input: 'payload-text',
        cwd: root,
        env: { ...process.env, PATH: bin },
        windowsHide: true,
      });

      expect({
        status: result.status,
        error: result.error?.message,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual({
        status: 0,
        error: undefined,
        stdout: 'STDIN:payload-text\nARGS:--version',
        stderr: '',
      });
      expect(result.stdout).toBe('STDIN:payload-text\nARGS:--version');
    },
  );
});

function pluginBatchCommandLine(modulePath: string, file: string, args: readonly string[]): string {
  const source = `import { batchCommandLine } from ${JSON.stringify(pathToFileURL(modulePath).href)};
process.stdout.write(batchCommandLine(process.env.SPAWN_FILE ?? '', JSON.parse(process.env.SPAWN_ARGS ?? '[]')));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SPAWN_FILE: file,
      SPAWN_ARGS: JSON.stringify(args),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
