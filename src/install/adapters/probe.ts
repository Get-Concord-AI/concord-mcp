import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { spawnCommandSync } from '../spawn-command.js';

/** Small probes for finding a harness executable and reading its version. */

export function executablePath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env['PATH'];
  if (path === undefined) return undefined;
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of path.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): {
  ok: boolean;
  output: string;
} {
  const result = spawnCommandSync(command, args, { env, timeout: 15_000 });
  return {
    ok: result.status === 0,
    output: result.error?.message ?? `${result.stdout}${result.stderr}`.trim(),
  };
}

export function versionTuple(output: string): number[] | undefined {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/u.exec(output);
  if (match === null) return undefined;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

export function atLeast(actual: readonly number[], required: readonly number[]): boolean {
  for (let index = 0; index < required.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}
