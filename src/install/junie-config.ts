import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { HARNESS_CONFIGS } from '../domain/harness-config.js';
import { userHome } from '../config/paths.js';
import { spawnCommandSync } from './spawn-command.js';
import {
  hasMcpServer,
  isConcordServerOwned,
  removeMcpServer,
  upsertMcpServer,
} from './mcp-config.js';

function executablePath(name: string, env: NodeJS.ProcessEnv): string | undefined {
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

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): { output: string } {
  const result = spawnCommandSync(command, args, { env, timeout: 15_000 });
  return { output: result.error?.message ?? `${result.stdout}${result.stderr}`.trim() };
}

function versionTuple(output: string): number[] | undefined {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/u.exec(output);
  if (match === null) return undefined;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function atLeast(version: number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i += 1) {
    const a = version[i];
    const m = minimum[i];
    if (a === undefined || m === undefined) return false;
    if (a > m) return true;
    if (a < m) return false;
  }
  return true;
}

function junieMcpPath(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.junie', 'mcp', 'mcp.json');
}

export function junieMcpInstalled(env: NodeJS.ProcessEnv): boolean {
  const mcpPath = junieMcpPath(env);
  return existsSync(mcpPath) && hasMcpServer(readFileSync(mcpPath, 'utf8'));
}

export function installJunieMcpConfig(env: NodeJS.ProcessEnv): void {
  const mcpPath = junieMcpPath(env);
  if (existsSync(mcpPath)) {
    const existing = readFileSync(mcpPath, 'utf8');
    if (!hasMcpServer(existing)) {
      mkdirSync(dirname(mcpPath), { recursive: true });
      writeFileSync(mcpPath, upsertMcpServer(existing));
    }
  } else {
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, upsertMcpServer(undefined));
  }
}

export function uninstallJunieMcpConfig(env: NodeJS.ProcessEnv): void {
  const mcpPath = junieMcpPath(env);
  if (!existsSync(mcpPath)) return;
  try {
    const existing = readFileSync(mcpPath, 'utf8');
    if (hasMcpServer(existing) && isConcordServerOwned(existing)) {
      writeFileSync(mcpPath, removeMcpServer(existing));
    }
  } catch {
    // Unreadable or malformed config is left untouched.
  }
}

import type { AdapterReport } from './adapters/index.js';

export function statusJunie(env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS.junie;
  const executable = executablePath(config.executable, env);
  if (executable === undefined) {
    return {
      harness: config.name,
      detected: false,
      status: 'not_detected',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: 'Junie CLI was not found on PATH.',
    };
  }
  const version = versionTuple(run(executable, ['--version'], env).output);
  if (version === undefined || !atLeast(version, config.minimumVersion)) {
    return {
      harness: config.name,
      detected: true,
      status: 'unsupported_version',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: config.unsupportedDetail,
    };
  }
  const installed = junieMcpInstalled(env);
  return {
    harness: config.name,
    detected: true,
    status: installed ? 'installed' : 'action_required',
    monitor: config.monitor.kind,
    capabilities: installed ? [...config.installedCapabilities] : ['pull', 'busy'],
    detail: installed
      ? config.installedDetail
      : 'Concord MCP server is not yet registered with Junie.',
  };
}
