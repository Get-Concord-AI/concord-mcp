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

/** A `[[table]]` block's line range, `[start, end)` in the source's lines. */
export interface TomlBlock {
  readonly start: number;
  readonly end: number;
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

/**
 * Ranges of `[[table]]` blocks whose `name = …` line satisfies `owned`. Header
 * and key detection skips lines inside multi-line strings and accepts quoted
 * keys (`"mcp_servers"`, `['hooks'.env]`); `[table.child]` subtables belong to
 * the preceding array element, so they stay inside its block, while any other
 * header ends it. Env assignments are collected so callers can prove a block
 * is Concord-shaped before treating it as ours.
 */
export function concordTomlBlocks(
  source: string,
  table: string,
  owned: (block: TomlBlock) => boolean,
): TomlBlock[] {
  const lines = [...tomlLines(source)];
  // A table segment may be bare or quoted: `mcp_servers`, `"mcp_servers"`,
  // `'mcp_servers'` all name the same TOML key.
  const seg = `(?:"${table}"|'${table}'|${table})`;
  const header = new RegExp(`^\\s*\\[\\[\\s*${seg}\\s*\\]\\]`, 'u');
  const anyHeader = /^\s*\[/u;
  const childHeader = new RegExp(`^\\s*\\[+\\s*${seg}\\s*\\.`, 'u');
  const envHeader = new RegExp(
    `^\\s*\\[+\\s*${seg}\\s*\\.\\s*["']?env["']?\\s*\\]+\\s*(?:#.*)?$`,
    'u',
  );
  // `[mcp_servers.env.<sub>]` nests env content the key reader cannot name.
  const envSubHeader = new RegExp(`^\\s*\\[+\\s*${seg}\\s*\\.\\s*["']?env["']?\\s*\\.`, 'u');
  const namePattern = /^\s*["']?name["']?\s*=\s*(?:"([^"]*)"|'([^']*)')/u;
  const fieldPattern = /^\s*["']?([A-Za-z0-9_-]+)["']?\s*=\s*(?:"([^"]*)"|'([^']*)')/u;
  const envDotted = /^\s*["']?env["']?\s*\.\s*(\S+?)\s*=/u;
  const envInline = /^\s*["']?env["']?\s*=\s*\{(.*)\}/u;
  const envInlineOpen = /^\s*["']?env["']?\s*=\s*\{/u;
  const envAssign = /^\s*["']?env["']?\s*=/u;
  const assignKey = /^\s*["']?([A-Za-z0-9_-]+)["']?\s*=/u;
  const envChildKey = /^\s*["']?([A-Za-z0-9_-]+)["']?\s*=/u;
  const envInnerKey = /(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/gu;
  const envChildWeird = /^\s*[^=\s#"'][^=]*=|^\s*["'][^"']*["']\s*=/u;
  const blocks: TomlBlock[] = [];
  let open: { start: number; end: number } | undefined;
  let ownedName: string | undefined;
  let inChildTable = false;
  let inEnvChild = false;
  let envOpaque = false;
  let keysOpaque = false;
  const envKeys: string[] = [];
  const assignKeys: string[] = [];
  let fields: Record<string, string> = {};
  const reset = (): void => {
    open = undefined;
    ownedName = undefined;
    inChildTable = false;
    inEnvChild = false;
    envOpaque = false;
    keysOpaque = false;
    envKeys.length = 0;
    assignKeys.length = 0;
    fields = {};
  };
  const flush = (end: number): void => {
    if (open !== undefined && ownedName !== undefined) {
      const block: TomlBlock = {
        start: open.start,
        end,
        name: ownedName,
        fields,
        keys: [...assignKeys],
        envKeys: [...envKeys],
        envOpaque,
        keysOpaque,
      };
      if (owned(block)) blocks.push(block);
    }
    reset();
  };
  lines.forEach((line, index) => {
    const { text, inString } = line;
    if (inString) return;
    const isHeader = anyHeader.test(text);
    if (open !== undefined && isHeader) {
      if (!childHeader.test(text)) {
        flush(index);
      } else {
        inChildTable = true;
        inEnvChild = envHeader.test(text);
        if (!inEnvChild && envSubHeader.test(text)) envOpaque = true;
        return;
      }
    }
    if (open === undefined) {
      if (header.test(text)) {
        open = { start: index, end: lines.length };
      }
      return;
    }
    if (inEnvChild) {
      const key = envChildKey.exec(text);
      if (key !== null) envKeys.push(key[1] ?? '');
      else if (envChildWeird.test(text)) envOpaque = true;
      return;
    }
    if (inChildTable) return;
    const assign = assignKey.exec(text);
    if (assign !== null) assignKeys.push(assign[1] ?? '');
    if (ownedName === undefined) {
      const match = namePattern.exec(text);
      if (match !== null) ownedName = match[1] ?? match[2] ?? '';
    }
    const field = fieldPattern.exec(text);
    if (field !== null) fields[field[1] ?? ''] = field[2] ?? field[3] ?? '';
    const dotted = envDotted.exec(text);
    if (dotted !== null) {
      const key = dotted[1]?.replace(/^['"]|['"]$/gu, '') ?? '';
      if (/^[A-Za-z0-9_-]+$/u.test(key)) envKeys.push(key);
      else envOpaque = true;
      return;
    }
    // `env."quoted.key" = …` and friends: an env assignment we cannot name.
    if (/^\s*["']?env["']?\s*\./u.test(text)) {
      envOpaque = true;
      return;
    }
    const inline = envInline.exec(text);
    if (inline !== null) {
      const inner = inline[1] ?? '';
      for (const match of inner.matchAll(envInnerKey)) {
        envKeys.push(match[1] ?? match[2] ?? match[3] ?? '');
      }
      // Bare dotted keys (`A.B = …`), nested inline tables/arrays, or key
      // shapes the reader cannot name all mean env content we cannot fully
      // account for — the entry stays the user's.
      if (/[A-Za-z0-9_-]+\.[A-Za-z0-9_.]+\s*=|[[\]{}]/u.test(inner)) envOpaque = true;
      return;
    }
    if (envInlineOpen.test(text) || envAssign.test(text)) envOpaque = true;
    // Any other assignment-shaped line this scanner cannot name — a quoted
    // key with escapes, a dotted key, a key with whitespace — must not cost
    // the user their setting: the block stops being one Concord can own.
    if (assign === null && /^\s*(?!#)\S[^=]*=/u.test(text)) keysOpaque = true;
  });
  if (open !== undefined) flush(lines.length);
  return blocks;
}

/** Source with every owned `[[table]]` block removed, plus the blank lines after it. */
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
  const seg = `(?:"${table}"|'${table}'|${table})`;
  const assignment = new RegExp(`^\\s*${seg}\\s*=`, 'u');
  const dotted = new RegExp(`^\\s*${seg}\\s*\\.`, 'u');
  const emptyArray = new RegExp(`^\\s*${seg}\\s*=\\s*\\[\\s*\\]\\s*(?:#.*)?$`, 'u');
  // A single-bracket `[table]` header (quoted segments included) makes
  // `table` a TOML table, which `[[table]]` entries cannot coexist with.
  const exactTableHeader = new RegExp(`^\\s*\\[\\s*${seg}\\s*\\]\\s*(?:#.*)?$`, 'u');
  // `[table.child]` makes `table` a table too — unless a `[[table]]` array
  // element precedes it, in which case the child legitimately belongs to that
  // element and array entries coexist with it fine.
  const childTableHeader = new RegExp(`^\\s*\\[\\s*${seg}\\s*\\.`, 'u');
  const arrayHeader = new RegExp(`^\\s*\\[\\[\\s*${seg}\\s*\\]\\]`, 'u');
  let index = 0;
  let pastHeaders = false;
  let sawArray = false;
  for (const { text, inString } of tomlLines(source)) {
    if (!inString) {
      if (/^\s*\[/u.test(text)) {
        pastHeaders = true;
        if (arrayHeader.test(text)) {
          sawArray = true;
        } else if (exactTableHeader.test(text)) {
          return { index, empty: false };
        } else if (childTableHeader.test(text) && !sawArray) {
          return { index, empty: false };
        }
      } else if (!pastHeaders) {
        // Bare and dotted keys only mean `table` before the first header;
        // afterwards they belong to whichever table is open.
        if (assignment.test(text)) {
          return { index, empty: emptyArray.test(text) };
        }
        if (dotted.test(text)) return { index, empty: false };
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
    block.keys.every((key) => MCP_OWNED_KEYS.has(key))
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
