import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userHome } from '../config/paths.js';
import {
  isJsonObject,
  objectEnd,
  parseJsoncObject,
  propertyObject,
  removeProperty,
  uncomment,
} from './jsonc-edit.js';
import type { JsonObject } from './json-value.js';

const SERVER = 'concord';
const KIND_VAR = 'CONCORD_AGENT_KIND';
const KIND = 'devin';

export function devinMcpConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string,
): string {
  if (projectRoot !== undefined) return join(projectRoot, '.devin', 'mcp_config.json');
  const appData = env['APPDATA']?.trim();
  return appData === undefined || appData === ''
    ? join(userHome(env), '.config', 'devin', 'mcp_config.json')
    : join(appData, 'devin', 'mcp_config.json');
}

/**
 * Devin starts its MCP servers with the environment it was launched from, so a
 * Devin started inside a Claude Code terminal carries `CLAUDE_CODE_SESSION_ID`.
 * Naming the kind keeps the server from adopting that session as its own; Devin
 * exposes no session id of its own, so the agent_id the hook hands the model is used.
 */
function concordEntry(existing: JsonObject): JsonObject {
  const env = existing['env'];
  return {
    ...existing,
    command: 'concord-mcp',
    env: { ...(isJsonObject(env) ? env : {}), [KIND_VAR]: KIND },
  };
}

export function upsertDevinMcpConfig(text: string | undefined): string {
  const source = text ?? '{}';
  const config = parseJsoncObject(source);
  const servers = config['mcpServers'];
  if (
    servers !== undefined &&
    (typeof servers !== 'object' || servers === null || Array.isArray(servers))
  ) {
    throw new Error('mcpServers must be an object');
  }
  const entry = JSON.stringify(concordEntry({}));
  const range = propertyObject(source, 'mcpServers');
  if (range !== undefined) {
    const serverRange = propertyObject(source.slice(range.open, range.close + 1), SERVER);
    if (serverRange !== undefined) {
      const start = range.open + serverRange.open;
      const end = range.open + serverRange.close;
      const old = parseJsoncObject(source.slice(start, end + 1));
      const env = old['env'];
      if (old['command'] === 'concord-mcp' && isJsonObject(env) && env[KIND_VAR] === KIND)
        return source;
      return `${source.slice(0, start)}${JSON.stringify(concordEntry(old))}${source.slice(end + 1)}`;
    }
    const hasEntries = Object.keys(servers ?? {}).length > 0;
    const indent =
      /^\s*/u.exec(source.slice(0, range.close).split(/\r?\n/u).at(-1) ?? '')?.[0] ?? '  ';
    const insertion = `${hasEntries ? ',' : ''}\n${indent}  "${SERVER}": ${entry}\n${indent}`;
    return `${source.slice(0, range.close)}${insertion}${source.slice(range.close)}`;
  }
  const close = objectEnd(source, uncomment(source).indexOf('{'));
  const hasEntries = Object.keys(config).length > 0;
  return `${source.slice(0, close)}${hasEntries ? ',' : ''}\n  "mcpServers": {\n    "${SERVER}": ${entry}\n  }\n${source.slice(close)}`;
}

export function removeDevinMcpConfig(text: string): string {
  parseJsoncObject(text);
  const range = propertyObject(text, 'mcpServers');
  if (range === undefined) return text;
  const child = propertyObject(text.slice(range.open, range.close + 1), SERVER);
  if (child === undefined) return text;
  return removeProperty(text, range, {
    key: range.open + child.key,
    close: range.open + child.close,
  });
}

export function installDevinMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string,
): string {
  const path = devinMcpConfigPath(env, projectRoot);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const next = upsertDevinMcpConfig(current);
  if (next !== current) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, { mode: 0o600 });
  }
  return path;
}

export function devinMcpInstalled(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string,
): boolean {
  const path = devinMcpConfigPath(env, projectRoot);
  if (!existsSync(path)) return false;
  try {
    return hasDevinMcpServer(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

export function uninstallDevinMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string,
): string | undefined {
  const path = devinMcpConfigPath(env, projectRoot);
  if (!existsSync(path)) return undefined;
  const current = readFileSync(path, 'utf8');
  const next = removeDevinMcpConfig(current);
  if (next === current) return undefined;
  writeFileSync(path, next);
  return path;
}

export function hasDevinMcpServer(text: string): boolean {
  try {
    const config = parseJsoncObject(text);
    const servers = config['mcpServers'];
    return (
      typeof servers === 'object' &&
      servers !== null &&
      !Array.isArray(servers) &&
      'concord' in servers
    );
  } catch {
    return false;
  }
}
