/**
 * Hooks import this file from the packaged plugin tree. Each relay directory
 * is linked on its own, and Node resolves those imports from this real path.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

const batchExtension = /\.(?:cmd|bat)$/iu;

export function quoteCmdArgument(value) {
  if (value.length === 0) return '""';
  const escaped = value.replaceAll('%', '%%').replaceAll('"', '""');
  if (value !== escaped || /[\s"&|<>^]/u.test(value)) return `"${escaped}"`;
  return value;
}

export function batchCommandLine(file, args) {
  const inner = [quoteCmdArgument(file), ...args.map((arg) => quoteCmdArgument(arg))].join(' ');
  return `"${inner}"`;
}

function envValue(env, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = env[key]?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function commandInterpreter(env) {
  const comSpec = envValue(env, 'ComSpec');
  if (comSpec !== undefined) return comSpec;
  const root = envValue(env, 'SystemRoot') ?? 'C:\\Windows';
  return join(root, 'System32', 'cmd.exe');
}

function resolveWindowsCommand(file, env) {
  if (extname(file) !== '' || isAbsolute(file) || file.includes('/') || file.includes('\\')) {
    return file;
  }
  const path = envValue(env, 'PATH');
  if (path === undefined) return file;
  for (const directory of path.split(delimiter)) {
    for (const extension of ['.exe', '.cmd', '.bat']) {
      const candidate = join(directory, `${file}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return file;
}

function batchTarget(file, args, env) {
  return {
    command: commandInterpreter(env),
    args: ['/d', '/v:off', '/s', '/c', batchCommandLine(file, args)],
  };
}

export function spawnCommandSync(file, args, options) {
  const env = options.env ?? process.env;
  const resolved = process.platform === 'win32' ? resolveWindowsCommand(file, env) : file;
  if (process.platform !== 'win32' || !batchExtension.test(resolved)) {
    return spawnSync(resolved, [...args], { ...options, shell: false });
  }
  const target = batchTarget(resolved, args, env);
  return spawnSync(target.command, [...target.args], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  });
}
