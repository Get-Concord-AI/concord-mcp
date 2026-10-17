import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';

const SERVER = 'concord';
const objectSchema = z.record(z.string(), z.unknown());

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

function uncomment(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (part, quoted: string | undefined) => quoted ?? part.replace(/[^\r\n]/gu, ' '),
  );
}

function parsed(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(uncomment(text));
  return objectSchema.parse(value);
}

function objectEnd(text: string, open: number): number {
  const clean = uncomment(text);
  let depth = 0;
  let inString = false;
  for (let index = open; index < clean.length; index += 1) {
    const char = clean[index];
    if (char === '"' && clean[index - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return index;
  }
  throw new Error('Unclosed JSON object');
}

function propertyObject(text: string, key: string): { open: number; close: number } | undefined {
  const clean = uncomment(text);
  const match = new RegExp(`"${key}"\\s*:\\s*\\{`, 'u').exec(clean);
  if (match === null) return undefined;
  const open = match.index + match[0].lastIndexOf('{');
  return { open, close: objectEnd(clean, open) };
}

export function upsertDevinMcpConfig(text: string | undefined): string {
  const source = text ?? '{}';
  const config = parsed(source);
  const servers = config['mcpServers'];
  if (
    servers !== undefined &&
    (typeof servers !== 'object' || servers === null || Array.isArray(servers))
  ) {
    throw new Error('mcpServers must be an object');
  }
  const entry = '{ "command": "concord-mcp" }';
  const range = propertyObject(source, 'mcpServers');
  if (range !== undefined) {
    const serverRange = propertyObject(source.slice(range.open, range.close + 1), SERVER);
    if (serverRange !== undefined) {
      const start = range.open + serverRange.open;
      const end = range.open + serverRange.close;
      const old = parsed(source.slice(start, end + 1));
      if (old['command'] === 'concord-mcp') return source;
      return `${source.slice(0, start)}${entry}${source.slice(end + 1)}`;
    }
    const hasEntries = Object.keys(servers ?? {}).length > 0;
    const indent =
      /^\s*/u.exec(source.slice(0, range.close).split(/\r?\n/u).at(-1) ?? '')?.[0] ?? '  ';
    const insertion = `${hasEntries ? ',' : ''}\n${indent}  "${SERVER}": ${entry}\n${indent}`;
    return `${source.slice(0, range.close)}${insertion}${source.slice(range.close)}`;
  }
  const root = propertyObject(source, '__never__');
  const close = root?.close ?? objectEnd(source, uncomment(source).indexOf('{'));
  const hasEntries = Object.keys(config).length > 0;
  return `${source.slice(0, close)}${hasEntries ? ',' : ''}\n  "mcpServers": {\n    "${SERVER}": ${entry}\n  }\n${source.slice(close)}`;
}

export function removeDevinMcpConfig(text: string): string {
  parsed(text);
  const range = propertyObject(text, 'mcpServers');
  if (range === undefined) return text;
  const child = propertyObject(text.slice(range.open, range.close + 1), SERVER);
  if (child === undefined) return text;
  let start = uncomment(text).indexOf(`"${SERVER}"`, range.open);
  let end = range.open + child.close + 1;
  const clean = uncomment(text);
  if (clean[end] === ',') end += 1;
  else {
    const precedingComma = clean.lastIndexOf(',', start);
    if (precedingComma > range.open) start = precedingComma;
  }
  return `${text.slice(0, start)}${text.slice(end)}`;
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
    const config = parsed(text);
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
