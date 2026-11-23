import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userHome } from '../config/paths.js';
import { tomlLines } from './toml-lines.js';

/**
 * Mistral Vibe keeps user-level configuration in `~/.vibe/`: MCP servers as
 * `[[mcp_servers]]` tables in `config.toml`, lifecycle hooks as `[[hooks]]`
 * tables in `hooks.toml`. Vibe has no TOML library we can depend on, so the
 * writers below edit line ranges: every `[[table]]` block Concord owns is
 * recognised by its `name` and rewritten, everything else is preserved
 * byte-for-byte.
 */

export function vibeHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['VIBE_HOME']?.trim();
  return configured === undefined || configured === '' ? join(userHome(env), '.vibe') : configured;
}

export function vibeMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(vibeHome(env), 'config.toml');
}

export function vibeHooksPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(vibeHome(env), 'hooks.toml');
}

/** A `[[table]]` block's line range, `[start, end)` in the source's lines. */
export interface TomlBlock {
  readonly start: number;
  readonly end: number;
  /** The block's `name = …` value, when it has one. */
  readonly name: string | undefined;
  /** `key = "value"` pairs in the block's own table, before any child table. */
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Ranges of `[[table]]` blocks whose `name = …` line satisfies `owned`. Header
 * and key detection skips lines inside multi-line strings; `[table.child]`
 * subtables belong to the preceding array element, so they stay inside its
 * block, while any other header ends it.
 */
export function concordTomlBlocks(
  source: string,
  table: string,
  owned: (name: string) => boolean,
): TomlBlock[] {
  const lines = [...tomlLines(source)];
  const header = new RegExp(`^\\s*\\[\\[\\s*${table}\\s*\\]\\]`, 'u');
  const anyHeader = /^\s*\[/u;
  const childHeader = new RegExp(`^\\s*\\[+\\s*${table}\\s*\\.`, 'u');
  const namePattern = /^\s*name\s*=\s*(?:"([^"]*)"|'([^']*)')/u;
  const fieldPattern = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/u;
  const blocks: TomlBlock[] = [];
  let open: { start: number; end: number } | undefined;
  let ownedName: string | undefined;
  let inChildTable = false;
  let fields: Record<string, string> = {};
  const flush = (end: number): void => {
    if (open !== undefined && ownedName !== undefined && owned(ownedName)) {
      blocks.push({ start: open.start, end, name: ownedName, fields });
    }
    open = undefined;
    ownedName = undefined;
    inChildTable = false;
    fields = {};
  };
  lines.forEach((line, index) => {
    const { text, inString } = line;
    if (inString) return;
    const isHeader = anyHeader.test(text);
    if (open !== undefined && isHeader && !childHeader.test(text)) flush(index);
    if (open === undefined && header.test(text)) {
      open = { start: index, end: lines.length };
      return;
    }
    if (open === undefined) return;
    if (childHeader.test(text)) {
      inChildTable = true;
      return;
    }
    if (inChildTable) return;
    if (ownedName === undefined) {
      const match = namePattern.exec(text);
      if (match !== null) ownedName = match[1] ?? match[2] ?? '';
    }
    const field = fieldPattern.exec(text);
    if (field !== null) fields[field[1] ?? ''] = field[2] ?? field[3] ?? '';
  });
  if (open !== undefined) flush(lines.length);
  return blocks;
}

/** Source with every owned `[[table]]` block removed, plus the blank lines after it. */
export function removeTomlBlocks(
  source: string,
  table: string,
  owned: (name: string) => boolean,
): string {
  const blocks = concordTomlBlocks(source, table, owned);
  if (blocks.length === 0) return source;
  const lines = source.split(/\r?\n/u);
  const drop = new Set<number>();
  for (const block of blocks) {
    for (let index = block.start; index < block.end; index += 1) drop.add(index);
    // Swallow the blank separator lines the block leaves behind.
    for (let index = block.end; index < lines.length; index += 1) {
      if ((lines[index] ?? '').trim() === '') drop.add(index);
      else break;
    }
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return lines.filter((_, index) => !drop.has(index)).join(eol);
}

/** Append `block` (already TOML text) to `source`, separated by a blank line. */
export function appendTomlBlock(source: string, block: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const trimmed = source.replace(/\s+$/u, '');
  const body = block.trimEnd().split('\n').join(eol);
  if (trimmed === '') return `${body}${eol}`;
  return `${trimmed}${eol}${eol}${body}${eol}`;
}

/** Source with the line at `index` removed. */
export function dropTomlLine(source: string, index: number): string {
  const lines = source.split(/\r?\n/u);
  lines.splice(index, 1);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return lines.join(eol);
}

/**
 * A bare `table = …` key before the first table header — the only place a
 * top-level key can live. `[[table]]` entries cannot coexist with it: an
 * empty array converts cleanly, anything else means the key already means
 * something else and the file must be left alone.
 */
export function bareTomlTableValue(
  source: string,
  table: string,
): { index: number; empty: boolean } | undefined {
  const assignment = new RegExp(`^\\s*${table}\\s*=`, 'u');
  const emptyArray = new RegExp(`^\\s*${table}\\s*=\\s*\\[\\s*\\]\\s*(?:#.*)?$`, 'u');
  let index = 0;
  for (const { text, inString } of tomlLines(source)) {
    if (!inString && /^\s*\[/u.test(text)) return undefined;
    if (!inString && assignment.test(text)) {
      return { index, empty: emptyArray.test(text) };
    }
    index += 1;
  }
  return undefined;
}

const MCP_TABLE = 'mcp_servers';
const MCP_NAME = 'concord';
const MCP_BLOCK = [
  '[[mcp_servers]]',
  `name = "${MCP_NAME}"`,
  'transport = "stdio"',
  'command = "concord-mcp"',
  // Vibe scrubs its session environment before spawning MCP children, so the
  // kind pin only guards against an inherited foreign session id.
  'env = { CONCORD_AGENT_KIND = "vibe" }',
].join('\n');

export function upsertVibeMcpConfig(source: string | undefined): string {
  const current = source ?? '';
  const bare = bareTomlTableValue(current, MCP_TABLE);
  if (bare !== undefined && !bare.empty) return current;
  const base = bare === undefined ? current : dropTomlLine(current, bare.index);
  const stripped = removeTomlBlocks(base, MCP_TABLE, (name) => name === MCP_NAME);
  return appendTomlBlock(stripped, MCP_BLOCK);
}

export function hasVibeMcpServer(source: string): boolean {
  return concordTomlBlocks(source, MCP_TABLE, (name) => name === MCP_NAME).some(
    (block) => block.fields['transport'] === 'stdio' && block.fields['command'] === 'concord-mcp',
  );
}

export function installVibeMcpConfig(env: NodeJS.ProcessEnv = process.env): string {
  const path = vibeMcpConfigPath(env);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const next = upsertVibeMcpConfig(current);
  if (next !== current) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
  }
  return path;
}

export function vibeMcpInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = vibeMcpConfigPath(env);
  if (!existsSync(path)) return false;
  try {
    return hasVibeMcpServer(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

export function uninstallVibeMcpConfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = vibeMcpConfigPath(env);
  if (!existsSync(path)) return undefined;
  const current = readFileSync(path, 'utf8');
  const next = removeTomlBlocks(current, MCP_TABLE, (name) => name === MCP_NAME);
  if (next === current) return undefined;
  writeFileSync(path, next);
  return path;
}
