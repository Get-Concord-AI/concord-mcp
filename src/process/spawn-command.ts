import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

const batchExtension = /\.(?:cmd|bat)$/iu;

/**
 * Spawn an executable directly.
 *
 * Windows `CreateProcess` cannot start `.cmd` or `.bat` files. Those are run
 * with `cmd.exe /d /v:off /s /c`, and the program path is quoted separately from
 * its arguments so a path containing spaces is one command.
 */
export function quoteCmdArgument(value: string): string {
  if (value.length === 0) return '""';
  const escaped = value.replaceAll('%', '%%').replaceAll('"', '""');
  if (value !== escaped || /[\s"&|<>^]/u.test(value)) return `"${escaped}"`;
  return value;
}

/** One `/c` argument. `/s` removes the outer quotes and leaves the inner quoting. */
export function batchCommandLine(file: string, args: readonly string[]): string {
  const inner = [quoteCmdArgument(file), ...args.map((arg) => quoteCmdArgument(arg))].join(' ');
  return `"${inner}"`;
}

function commandEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env ?? process.env;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = env[key]?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function commandInterpreter(env: NodeJS.ProcessEnv): string {
  const comSpec = envValue(env, 'ComSpec');
  if (comSpec !== undefined) return comSpec;
  const root = envValue(env, 'SystemRoot') ?? 'C:\\Windows';
  return join(root, 'System32', 'cmd.exe');
}

function resolveWindowsCommand(file: string, env: NodeJS.ProcessEnv): string {
  if (extname(file) !== '' || isAbsolute(file) || file.includes('/') || file.includes('\\')) {
    return file;
  }
  const path = envValue(env, 'PATH');
  if (path === undefined) return file;
  for (const directory of path.split(delimiter)) {
    for (const extension of ['.exe', '.cmd', '.bat'] as const) {
      const candidate = join(directory, `${file}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return file;
}

function isBatchFile(file: string): boolean {
  return process.platform === 'win32' && batchExtension.test(file);
}

function batchTarget(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: readonly string[] } {
  return {
    command: commandInterpreter(env),
    args: ['/d', '/v:off', '/s', '/c', batchCommandLine(file, args)],
  };
}

export function spawnCommand(
  file: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const env = commandEnv(options.env);
  const resolved = process.platform === 'win32' ? resolveWindowsCommand(file, env) : file;
  if (!isBatchFile(resolved)) return spawn(resolved, [...args], { ...options, shell: false });
  const target = batchTarget(resolved, args, env);
  return spawn(target.command, [...target.args], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  });
}

type Utf8SpawnSyncOptions = SpawnSyncOptions & { encoding: 'utf8' };

export function spawnCommandSync(
  file: string,
  args: readonly string[],
  options: Utf8SpawnSyncOptions,
): SpawnSyncReturns<string> {
  const env = commandEnv(options.env);
  const resolved = process.platform === 'win32' ? resolveWindowsCommand(file, env) : file;
  if (!isBatchFile(resolved)) {
    return spawnSync(resolved, [...args], { ...options, encoding: 'utf8', shell: false });
  }
  const target = batchTarget(resolved, args, env);
  return spawnSync(target.command, [...target.args], {
    ...options,
    encoding: 'utf8',
    shell: false,
    windowsVerbatimArguments: true,
  });
}
