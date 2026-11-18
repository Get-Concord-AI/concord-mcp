import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userHome } from '../config/paths.js';
import {
  agentKindEnv,
  hasMcpServer,
  isConcordServerOwned,
  removeMcpServer,
  upsertMcpServer,
} from './mcp-config.js';

/** Junie's config home: `JUNIE_HOME` when set, else `~/.junie`. */
export function junieHome(env: NodeJS.ProcessEnv): string {
  const configured = env['JUNIE_HOME']?.trim();
  return configured === undefined || configured === ''
    ? join(userHome(env), '.junie')
    : configured;
}

function junieMcpPath(env: NodeJS.ProcessEnv): string {
  return join(junieHome(env), 'mcp', 'mcp.json');
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
