import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userHome } from '../config/paths.js';
import {
  decodeTomlBasicString,
  inlineTableKeys,
  tomlAssignment,
  tomlHeader,
  tomlLines,
  type TomlLine,
} from './toml-lines.js';

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
  if (configured === undefined || configured === '') return join(userHome(env), '.vibe');
  // Vibe expands a leading `~` itself; a quoted `~/…` in a dotfile reaches us
  // unexpanded, so match that here rather than writing to a literal `./~`.
  if (configured === '~') return userHome(env);
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return join(userHome(env), configured.slice(2));
  }
  return configured;
}

export function vibeMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(vibeHome(env), 'config.toml');
}

export function vibeHooksPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(vibeHome(env), 'hooks.toml');
}

/** A line range, `[start, end)` in the source's lines. */
export interface TomlRange {
  readonly start: number;
  readonly end: number;
}

/** A `[[table]]` array entry and the child tables TOML attaches to it. */
export interface TomlBlock {
  /** The parent array-entry section's line range, `[start, end)`. */
  readonly start: number;
  readonly end: number;
  /** The parent plus every child-table section, in source order. */
  readonly ranges: readonly TomlRange[];
  /** Normalized paths of child tables attached to this array entry. */
  readonly childTables: readonly string[];
  /** The block's `name = …` value, when it has one. */
  readonly name: string | undefined;
  /** `key = "value"` pairs in the block's own table, before any child table. */
  readonly fields: Readonly<Record<string, string>>;
  /** Every `key =` assignment name in the block's own table, any value shape. */
  readonly keys: readonly string[];
  /** Env var names the block assigns (`env = {…}`, `env.KEY`, `[table.env]`). */
  readonly envKeys: readonly string[];
  /** An `env` assignment exists that `envKeys` cannot fully account for. */
  readonly envOpaque: boolean;
  /** A `key = …` line exists in the block's own table that the scanner cannot name. */
  readonly keysOpaque: boolean;
}

interface TomlSection {
  readonly start: number;
  end: number;
  readonly path: string;
  readonly array: boolean;
}

interface BlockScan {
  readonly start: number;
  readonly end: number;
  readonly ranges: TomlRange[];
  readonly childTables: string[];
  name: string | undefined;
  readonly fields: Record<string, string>;
  readonly keys: string[];
  readonly envKeys: string[];
  envOpaque: boolean;
  keysOpaque: boolean;
}

const ENV_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const INLINE_ENV_PATTERN = /^\{(.*)\}\s*(?:#.*)?$/u;
const STRING_VALUE_PATTERN = /^(?:"([^"]*)"|'([^']*)')(?:\s*#.*)?$/u;

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function stringValue(value: string): string | undefined {
  const match = STRING_VALUE_PATTERN.exec(value);
  if (match === null) return undefined;
  const basic = match[1];
  if (basic !== undefined) return decodeTomlBasicString(basic);
  return match[2];
}

function scanInlineEnv(scan: BlockScan, value: string): void {
  const inline = INLINE_ENV_PATTERN.exec(value);
  if (inline === null) {
    scan.envOpaque = true;
    return;
  }
  const inner = inline[1] ?? '';
  for (const key of inlineTableKeys(value)) {
    if (ENV_KEY_PATTERN.test(key)) pushUnique(scan.envKeys, key);
    else scan.envOpaque = true;
  }
  // Bare dotted keys (`A.B = …`), nested inline tables/arrays, or key shapes
  // the reader cannot name all mean env content we cannot fully account for.
  if (/[A-Za-z0-9_-]+\.[A-Za-z0-9_.]+\s*=|[[\]{}]/u.test(inner)) scan.envOpaque = true;
}

function scanOwnLine(scan: BlockScan, text: string): void {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return;
  const assignment = tomlAssignment(text);
  if (assignment === undefined) {
    if (/^\s*(?!#)\S[^=]*=/u.test(text)) scan.keysOpaque = true;
    return;
  }
  const [key, ...rest] = assignment.parts;
  if (key === undefined || key === '') {
    scan.keysOpaque = true;
    return;
  }
  if (key === 'env') {
    pushUnique(scan.keys, key);
    if (rest.length === 1) {
      const envKey = rest[0] ?? '';
      if (ENV_KEY_PATTERN.test(envKey)) pushUnique(scan.envKeys, envKey);
      else scan.envOpaque = true;
      return;
    }
    if (rest.length > 1) {
      scan.envOpaque = true;
      return;
    }
    scanInlineEnv(scan, assignment.value);
    return;
  }
  if (rest.length > 0) {
    scan.keysOpaque = true;
    return;
  }
  pushUnique(scan.keys, key);
  const string = stringValue(assignment.value);
  if (string !== undefined) {
    if (scan.name === undefined && key === 'name') scan.name = string;
    scan.fields[key] = string;
  }
}

function scanEnvChildLine(scan: BlockScan, text: string): void {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return;
  const assignment = tomlAssignment(text);
  const [key, ...rest] = assignment?.parts ?? [];
  if (assignment === undefined || key === undefined || rest.length > 0) {
    scan.envOpaque = true;
    return;
  }
  if (ENV_KEY_PATTERN.test(key)) pushUnique(scan.envKeys, key);
  else scan.envOpaque = true;
}

function scanOwnSection(scan: BlockScan, lines: readonly TomlLine[], section: TomlSection): void {
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index];
    if (line !== undefined && !line.inString) scanOwnLine(scan, line.text);
  }
}

function scanEnvChildSection(
  scan: BlockScan,
  lines: readonly TomlLine[],
  section: TomlSection,
): void {
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index];
    if (line !== undefined && !line.inString) scanEnvChildLine(scan, line.text);
  }
}

function tomlSections(lines: readonly TomlLine[]): TomlSection[] {
  const sections: TomlSection[] = [];
  lines.forEach((line, index) => {
    if (line.inString) return;
    const header = tomlHeader(line.text);
    if (header === undefined) return;
    const previous = sections[sections.length - 1];
    if (previous !== undefined) previous.end = index;
    sections.push({ start: index, end: lines.length, path: header.path, array: header.array });
  });
  return sections;
}

function newBlockScan(section: TomlSection): BlockScan {
  return {
    start: section.start,
    end: section.end,
    ranges: [{ start: section.start, end: section.end }],
    childTables: [],
    name: undefined,
    fields: {},
    keys: [],
    envKeys: [],
    envOpaque: false,
    keysOpaque: false,
  };
}

function blockFromScan(scan: BlockScan): TomlBlock {
  return {
    start: scan.start,
    end: scan.end,
    ranges: scan.ranges.map((range) => ({ ...range })),
    childTables: [...scan.childTables],
    name: scan.name,
    fields: { ...scan.fields },
    keys: [...scan.keys],
    envKeys: [...scan.envKeys],
    envOpaque: scan.envOpaque,
    keysOpaque: scan.keysOpaque,
  };
}

/**
 * Ranges of `[[table]]` array entries whose `name = …` line satisfies `owned`.
 * TOML attaches `[table.child]` to the most recent `[[table]]` element even
 * when unrelated tables intervene, so a block may hold several non-contiguous
 * ranges. Header and key detection skips lines inside multi-line strings and
 * decodes valid quoted-key escapes. Env assignments are collected so callers
 * can prove a block is Concord-shaped before treating it as ours; anything the
 * scanner cannot account for stays user-owned.
 */
export function concordTomlBlocks(
  source: string,
  table: string,
  owned: (block: TomlBlock) => boolean,
): TomlBlock[] {
  const lines = [...tomlLines(source)];
  const sections = tomlSections(lines);
  const scans: BlockScan[] = [];
  const childPrefix = `${table}.`;
  const envPath = `${table}.env`;
  let active: BlockScan | undefined;

  for (const section of sections) {
    if (section.array && section.path === table) {
      active = newBlockScan(section);
      scans.push(active);
      scanOwnSection(active, lines, section);
      continue;
    }
    if (!section.array && section.path === table) {
      // A regular table cannot coexist with array entries in valid TOML. Do
      // not attach later children to the array in malformed input either.
      active = undefined;
      continue;
    }
    if (!section.path.startsWith(childPrefix) || active === undefined) continue;

    active.ranges.push({ start: section.start, end: section.end });
    active.childTables.push(section.path);
    if (!section.array && section.path === envPath) {
      scanEnvChildSection(active, lines, section);
    } else if (section.path === envPath || section.path.startsWith(`${envPath}.`)) {
      active.envOpaque = true;
    } else {
      active.keysOpaque = true;
    }
  }

  return scans.flatMap((scan) => {
    const block = blockFromScan(scan);
    return owned(block) ? [block] : [];
  });
}

/** Source with every owned `[[table]]` block and its attached child tables removed. */
export function removeTomlBlocks(
  source: string,
  table: string,
  owned: (block: TomlBlock) => boolean,
): string {
  const blocks = concordTomlBlocks(source, table, owned);
  if (blocks.length === 0) return source;
  const lines = source.split(/\r?\n/u);
  const drop = new Set<number>();
  for (const block of blocks) {
    for (const range of block.ranges) {
      for (let index = range.start; index < range.end; index += 1) drop.add(index);
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
  const childPrefix = `${table}.`;
  const emptyArray = /^\[\s*\]\s*(?:#.*)?$/u;
  let index = 0;
  let pastHeaders = false;
  let sawArray = false;
  for (const { text, inString } of tomlLines(source)) {
    if (!inString) {
      const header = tomlHeader(text);
      if (header !== undefined) {
        pastHeaders = true;
        if (header.array && header.path === table) {
          sawArray = true;
        } else if (!header.array && header.path === table) {
          return { index, empty: false };
        } else if (header.path.startsWith(childPrefix) && !sawArray) {
          return { index, empty: false };
        }
      } else if (!pastHeaders) {
        // Bare and dotted keys only mean `table` before the first header;
        // afterwards they belong to whichever table is open.
        const assignment = tomlAssignment(text);
        if (assignment?.path === table) {
          return { index, empty: emptyArray.test(assignment.value) };
        }
        if (assignment?.path.startsWith(childPrefix) === true) return { index, empty: false };
      }
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

const namedConcord = (block: TomlBlock): boolean => block.name === MCP_NAME;

/** The only keys the `[[mcp_servers]]` block Concord writes may carry. */
const MCP_OWNED_KEYS: ReadonlySet<string> = new Set(['name', 'transport', 'command', 'env']);

/**
 * The `[[mcp_servers]]` shape Concord writes: a stdio `concord-mcp` command,
 * only `CONCORD_*` env keys, and no extra settings. A `concord` entry in any
 * other shape — custom `cwd`/`args`/`enabled`/remote fields included — is the
 * user's own: main keeps a hand-written `concord` server (#361), so neither
 * setup nor uninstall may replace or remove it.
 */
function vibeMcpOwned(block: TomlBlock): boolean {
  return (
    block.name === MCP_NAME &&
    block.fields['transport'] === 'stdio' &&
    block.fields['command'] === 'concord-mcp' &&
    !block.envOpaque &&
    !block.keysOpaque &&
    block.envKeys.every((key) => key.startsWith('CONCORD_')) &&
    block.keys.every((key) => MCP_OWNED_KEYS.has(key)) &&
    block.childTables.every((path) => path === `${MCP_TABLE}.env`)
  );
}

export function upsertVibeMcpConfig(source: string | undefined): string {
  const current = source ?? '';
  const bare = bareTomlTableValue(current, MCP_TABLE);
  if (bare !== undefined && !bare.empty) return current;
  const base = bare === undefined ? current : dropTomlLine(current, bare.index);
  // A hand-written `concord` server wins over ours, as on main.
  if (concordTomlBlocks(base, MCP_TABLE, namedConcord).some((block) => !vibeMcpOwned(block))) {
    return current;
  }
  const stripped = removeTomlBlocks(base, MCP_TABLE, vibeMcpOwned);
  return appendTomlBlock(stripped, MCP_BLOCK);
}

export function hasVibeMcpServer(source: string): boolean {
  return concordTomlBlocks(source, MCP_TABLE, namedConcord).some(
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
  let current: string;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // An unreadable config is left untouched so the rest of uninstall proceeds.
    return undefined;
  }
  const next = removeTomlBlocks(current, MCP_TABLE, vibeMcpOwned);
  if (next === current) return undefined;
  writeFileSync(path, next);
  return path;
}
