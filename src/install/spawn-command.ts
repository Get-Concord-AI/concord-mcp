/**
 * Mirrors plugin/spawn-command.mjs, which hooks load from the plugin tree
 * without this build. npm installs harness CLIs on Windows as `.cmd` shims,
 * and Node refuses to spawn those without a shell.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';

const BATCH_EXTENSION = /\.(?:cmd|bat)$/iu;

export function quoteCmdArgument(value: string): string {
  if (value.length === 0) return '""';
  const escaped = value.replaceAll('%', '%%cd:~,%').replaceAll('"', '""');
  if (value !== escaped || /[\s"&|<>^]/u.test(value)) return `"${escaped}"`;
  return value;
}

export function batchCommandLine(file: string, args: readonly string[]): string {
  const inner = [quoteCmdArgument(file), ...args.map((arg) => quoteCmdArgument(arg))].join(' ');
  return `"${inner}"`;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, raw] of Object.entries(env)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = raw?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function commandInterpreter(env: NodeJS.ProcessEnv): string {
  const comSpec = envValue(env, 'ComSpec');
  if (comSpec !== undefined) return comSpec;
  return join(envValue(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe');
}

export interface SpawnCommandOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
}

/** Run a resolved executable without a shell, sending Windows batch shims through cmd.exe. */
export function spawnCommandSync(
  file: string,
  args: readonly string[],
  options: SpawnCommandOptions,
): SpawnSyncReturns<string> {
  const common = { ...options, encoding: 'utf8', shell: false, windowsHide: true } as const;
  if (process.platform !== 'win32' || !BATCH_EXTENSION.test(file)) {
    return spawnSync(file, [...args], common);
  }
  return spawnSync(
    commandInterpreter(options.env),
    ['/d', '/v:off', '/s', '/c', batchCommandLine(file, args)],
    { ...common, windowsVerbatimArguments: true },
  );
}
