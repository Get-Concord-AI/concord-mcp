import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { HARNESS_CONFIGS } from '../domain/harness-config.js';
import { userHome } from '../config/paths.js';
import { atLeast, executablePath, run, versionTuple } from './adapters/probe.js';
import { junieHooksInstalled } from './junie-hooks.js';
import {
  agentKindEnv,
  hasMcpServer,
  isConcordServerOwned,
  removeMcpServer,
  upsertMcpServer,
} from './mcp-config.js';

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
      writeFileSync(mcpPath, upsertMcpServer(existing, undefined, agentKindEnv('junie')));
    }
  } else {
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, upsertMcpServer(undefined, undefined, agentKindEnv('junie')));
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
  const mcpInstalled = junieMcpInstalled(env);
  const hooksInstalled = junieHooksInstalled(env);
  const installed = mcpInstalled && hooksInstalled;
  const missing: string[] = [];
  if (!mcpInstalled) missing.push('the Concord MCP server is not registered');
  if (!hooksInstalled) missing.push('the lifecycle hooks are missing from ~/.junie/config.json');
  return {
    harness: config.name,
    detected: true,
    status: installed ? 'installed' : 'action_required',
    monitor: config.monitor.kind,
    capabilities: installed ? [...config.installedCapabilities] : ['pull', 'busy'],
    detail: installed
      ? config.installedDetail
      : `Junie needs repair: ${missing.join(' and ')}. Run \`concord setup\` to install both.`,
  };
}
