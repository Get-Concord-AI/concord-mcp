import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CONCORD_SERVER_COMMAND, CONCORD_TOML_KEY } from './mcp-config.js';
import { tomlKeyPath, tomlLines, type TomlLine } from './toml-lines.js';

/** The TOML table Codex reads Concord's server definition from. */
export const CODEX_SECTION_HEADER = '[mcp_servers.concord]';

/** Matches any TOML table header, which terminates the preceding table. */
const TABLE_HEADER = /^\s*\[/u;

const COMMENT_LINE = /^\s*#/u;

/** Runs `edit` on `\n` line endings, then restores the file's own, taken from its first line. */
function inLineEnding(source: string, edit: (text: string) => string): string {
  const eol = /\r?\n/u.exec(source)?.[0] ?? '\n';
  const edited = edit(source.replaceAll('\r\n', '\n'));
  return eol === '\n' ? edited : edited.replaceAll('\n', eol);
}

/** Whether `line` starts a statement, rather than continuing a multi-line string or array. */
function startsStatement(line: TomlLine): boolean {
  return !line.inString && !line.inValue;
}

function isHeader(line: TomlLine): boolean {
  return startsStatement(line) && TABLE_HEADER.test(line.text);
}

function isBlank(line: TomlLine | undefined): boolean {
  return line !== undefined && startsStatement(line) && line.text.trim() === '';
}

/** Blank and comment lines belong to what follows them. */
function isDecoration(line: TomlLine | undefined): boolean {
  return (
    isBlank(line) || (line !== undefined && startsStatement(line) && COMMENT_LINE.test(line.text))
  );
}

/** Keeps `line` unless it is a second blank line in a row; string contents always stay. */
function keepLine(kept: TomlLine[], line: TomlLine): void {
  if (!isBlank(line) || !isBlank(kept[kept.length - 1])) kept.push(line);
}

/** Where the table at `header` ends: the next header, minus the comments above it. */
function tableEnd(lines: readonly TomlLine[], header: number): number {
  let end = lines.findIndex((line, index) => index > header && isHeader(line));
  if (end === -1) end = lines.length;
  while (end > header + 1 && isDecoration(lines[end - 1])) end -= 1;
  return end;
}

/**
 * Absolute path to Codex's user-global config. Unlike everything else `install`
 * writes this lives outside the repo, so `CODEX_HOME` is honored — both because
 * Codex itself respects it and because it lets tests target a temp directory.
 */
export function codexConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), 'config.toml');
}

/** Codex's user directory: `CODEX_HOME`, or `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['CODEX_HOME'];
  return home !== undefined && home.trim() !== '' ? home : join(homedir(), '.codex');
}

/** Normalize preceding content so exactly one blank line precedes our table. */
function withTrailingBlankLine(lines: readonly string[]): string {
  if (lines.length === 0) {
    return '';
  }
  return `${lines.join('\n').replace(/\n*$/u, '')}\n\n`;
}

/**
 * Idempotently add Concord's `[mcp_servers.concord]` table to a Codex TOML
 * config. This splices the table by line range rather than parsing and
 * re-serializing, so unrelated tables — and the comments and formatting around
 * them, which a round-trip through a parser would discard — survive verbatim.
 */
export function upsertCodexMcpServer(existing: string | undefined): string {
  return inLineEnding(existing ?? '', addServerTable);
}

function addServerTable(source: string): string {
  const section = `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"\n`;
  if (source.trim() === '') {
    return section;
  }

  const lines = [...tomlLines(source)];
  const found = lines.findIndex(
    (line) => startsStatement(line) && line.text.trim() === CODEX_SECTION_HEADER,
  );
  const start = found === -1 ? lines.length : found;

  // Our table runs until the next table header; a nested `[mcp_servers.concord.env]`
  // is such a header, so any subtable the user added is preserved as trailing content.
  // So are the comments above it, such as the hooks begin marker.
  let tailStart = found === -1 ? lines.length : tableEnd(lines, found);
  while (tailStart < lines.length && lines[tailStart]?.text.trim() === '') tailStart += 1;

  const head = withTrailingBlankLine(lines.slice(0, start).map((line) => line.text));
  const tail = lines
    .slice(tailStart)
    .map((line) => line.text)
    .join('\n');
  return tail === '' ? `${head}${section}` : `${head}${section}\n${tail}`;
}

const HOOKS_BEGIN = '# >>> concord hooks >>>';
const HOOKS_END = '# <<< concord hooks <<<';

/** Concord's Codex hooks: one per event, each with the exact command it runs. */
const CONCORD_HOOKS = [
  { event: 'SessionStart', command: 'concord inbox register --from-hook --provider codex' },
  {
    event: 'PostToolUse',
    command: 'concord inbox drain --from-hook --provider codex --format post-tool-use',
  },
  { event: 'Stop', command: 'concord inbox drain --from-hook --provider codex --format stop' },
] as const;

/**
 * Codex passes its session id on stdin rather than in the environment, so every
 * hook reads the payload to work out which agent it is.
 */
const CONCORD_HOOKS_BLOCK = [
  HOOKS_BEGIN,
  '# Delivers Concord messages from other agents into this session. Remove this',
  '# block (markers included) to opt out.',
  CONCORD_HOOKS.map(
    ({ event, command }) =>
      `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = "${command}"`,
  ).join('\n\n'),
  HOOKS_END,
].join('\n');

/** The markers and the note under the begin marker. */
const CONCORD_COMMENTS = new Set(
  CONCORD_HOOKS_BLOCK.split('\n').filter((line) => COMMENT_LINE.test(line)),
);

function isConcordComment(line: TomlLine): boolean {
  return startsStatement(line) && CONCORD_COMMENTS.has(line.text.trim());
}

/** The key of an array-of-tables header such as `[[ hooks.Stop ]] # note`. */
function arrayTableKey(line: TomlLine | undefined): string | undefined {
  if (line === undefined || !startsStatement(line)) return undefined;
  const key = /^\[\[([^\]]+)\]\]\s*(?:#.*)?$/u.exec(line.text.trim())?.[1];
  return key === undefined ? undefined : tomlKeyPath(key);
}

/** A TOML key: bare or quoted parts, dotted or not. */
const KEY = String.raw`(?:[\w-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[\w-]+|"[^"]*"|'[^']*'))*`;
const KEY_LINE = new RegExp(String.raw`^\s*(${KEY})\s*=`, 'u');
const STRING_ENTRY = new RegExp(
  String.raw`^(${KEY})\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$`,
  'u',
);

/** The key and string value a `key = "value"` line sets, ignoring a trailing comment. */
function stringEntry(line: TomlLine): { key: string; value: string } | undefined {
  if (!startsStatement(line)) return undefined;
  const match = STRING_ENTRY.exec(line.text.trim());
  const key = match?.[1];
  const value = match?.[2] ?? match?.[3];
  return key === undefined || value === undefined ? undefined : { key: tomlKeyPath(key), value };
}

/**
 * If the entry headed at `entry` runs exactly Concord's `command`: where its own
 * lines `end`, and where TOML's table ends (`tail`). Lines between the two came
 * after Concord's end marker, so they are the user's, though TOML attaches them here.
 */
function concordEntry(
  lines: readonly TomlLine[],
  entry: number,
  command: string,
): { end: number; tail: number } | undefined {
  const tail = tableEnd(lines, entry);
  const values = lines.slice(entry + 1, tail).map(stringEntry);
  const typeAt = values.findIndex((value) => value?.key === 'type' && value.value === 'command');
  const commandAt = values.findIndex(
    (value) => value?.key === 'command' && value.value === command,
  );
  if (typeAt === -1 || commandAt === -1) return undefined;

  // The first of Concord's comment lines after its keys, such as the end marker, ends the entry.
  const keys = entry + 1 + Math.max(typeAt, commandAt);
  const marker = lines.findIndex(
    (line, index) => index > keys && index < tail && isConcordComment(line),
  );
  return { end: marker === -1 ? tail : marker, tail };
}

function lineKey(line: TomlLine): string | undefined {
  if (!startsStatement(line)) return undefined;
  const key = KEY_LINE.exec(line.text)?.[1];
  return key === undefined ? undefined : tomlKeyPath(key);
}

/** Whether two keys can't share a table: the same key, or one inside the other. */
function clashes(key: string, other: string): boolean {
  return key === other || key.startsWith(`${other}.`) || other.startsWith(`${key}.`);
}

/**
 * Lines carried from repeated Concord blocks, merged into the one table they now
 * share: of clashing keys, the first is kept. Codex ignores these keys inside a
 * hook, but a clash would stop it loading the file at all.
 */
function mergeCarried(
  lines: readonly TomlLine[],
  taken: ReadonlySet<string> = new Set(),
): string[] {
  const seen = new Set(taken);
  const merged: string[] = [];
  let pending: string[] = [];
  let dropping = false;
  for (const line of lines) {
    // Comments and blank lines go with what follows them.
    if (isDecoration(line)) {
      pending.push(line.text);
      continue;
    }
    const key = lineKey(line);
    if (key !== undefined) {
      dropping = [...seen].some((other) => clashes(key, other));
      if (!dropping) seen.add(key);
    }
    if (!dropping) merged.push(...pending, line.text);
    pending = [];
  }
  return [...merged, ...pending];
}

/** A `[[hooks.<event>]]` group, and the entries TOML attaches to it. */
interface HookGroup {
  header: number;
  firstEntry: number | undefined;
  entries: number;
  concordEntries: number;
}

function removeRange(removed: Set<number>, start: number, end: number): void {
  for (let index = start; index < end; index += 1) removed.add(index);
}

/**
 * Concord's entries, and each group left with nothing of the user's: no other
 * entry and no key such as `matcher`. `carried` are the user's lines that TOML
 * attaches to Concord's entries. `spot` is the first removed group, unless a
 * user entry after it belongs to an earlier group that the block would steal.
 */
function concordHookLines(lines: readonly TomlLine[]): {
  removed: Set<number>;
  carried: Set<number>;
  spot: number | undefined;
} {
  const removed = new Set<number>();
  const carried = new Set<number>();
  const groups: HookGroup[] = [];
  const current = new Map<string, HookGroup>();
  const userEntries: { index: number; group: number | undefined }[] = [];
  for (const [index, line] of lines.entries()) {
    const key = arrayTableKey(line);
    const hook = CONCORD_HOOKS.find(
      ({ event }) => key === `hooks.${event}` || key === `hooks.${event}.hooks`,
    );
    if (hook === undefined) continue;
    if (key === `hooks.${hook.event}`) {
      const group = { header: index, firstEntry: undefined, entries: 0, concordEntries: 0 };
      groups.push(group);
      current.set(hook.event, group);
      continue;
    }
    const group = current.get(hook.event);
    if (group !== undefined) {
      group.entries += 1;
      group.firstEntry ??= index;
    }
    const found = concordEntry(lines, index, hook.command);
    if (found === undefined) {
      userEntries.push({ index, group: group?.header });
      continue;
    }
    removeRange(removed, index, found.end);
    for (let at = found.end; at < found.tail; at += 1) {
      const after = lines[at];
      if (after !== undefined && !isConcordComment(after)) carried.add(at);
    }
    if (group !== undefined) group.concordEntries += 1;
  }

  let spot: number | undefined;
  for (const group of groups) {
    if (group.entries === 0 || group.concordEntries < group.entries) continue;
    const ownEnd = tableEnd(lines, group.header);
    if (lines.slice(group.header + 1, ownEnd).some((line) => !isDecoration(line))) continue;
    let end = ownEnd;
    while (isDecoration(lines[end])) end += 1;
    removeRange(removed, group.header, end === group.firstEntry ? end : ownEnd);
    spot ??= group.header;
  }
  const first = spot;
  // The block would steal a later user entry whose group sits above it, or that has none.
  const steals = (entry: { index: number; group: number | undefined }): boolean =>
    first !== undefined && entry.index > first && (entry.group ?? -1) < first;
  if (userEntries.some(steals)) spot = undefined;
  return { removed, carried, spot };
}

/** User lines from after Concord's end markers that will share one table, and where they go. */
interface CarriedGroup {
  at: number;
  table: number;
  lines: TomlLine[];
}

/** The key of a table header such as `[tui]` or `[[hooks.Stop]]`. */
function headerKey(line: TomlLine): string | undefined {
  if (!startsStatement(line)) return undefined;
  const key = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/u.exec(line.text)?.[1];
  return key === undefined ? undefined : tomlKeyPath(key);
}

/**
 * For each table among `lines` (0 is the root), the keys it already sets,
 * including the tables nested under it: a carried line must not set them again.
 */
function keysByTable(lines: readonly TomlLine[]): Set<string>[] {
  const paths = [''];
  const keys = [new Set<string>()];
  for (const line of lines) {
    if (isHeader(line)) {
      paths.push(headerKey(line) ?? '');
      keys.push(new Set());
      continue;
    }
    const key = lineKey(line);
    if (key !== undefined) keys[keys.length - 1]?.add(key);
  }
  return keys.map((own, table) => {
    const path = paths[table] ?? '';
    const prefix = path === '' ? '' : `${path}.`;
    const nested = paths.filter(
      (other) => other !== '' && other !== path && other.startsWith(prefix),
    );
    return new Set([...own, ...nested.map((other) => other.slice(prefix.length))]);
  });
}

/**
 * `source` without Concord's hooks and comment lines, and where its first hook
 * was. `carried` holds the user's lines from after its end markers, grouped by
 * the table each would join once the hooks are gone.
 */
function stripConcordHooks(source: string): {
  lines: string[];
  spot: number | undefined;
  carried: CarriedGroup[];
  taken: Set<string>[];
} {
  const lines = [...tomlLines(source)];
  const found = concordHookLines(lines);
  const kept: TomlLine[] = [];
  const carried = new Map<number, CarriedGroup>();
  let tables = 0;
  let spot: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (index === found.spot) spot = kept.length;
    if (found.carried.has(index)) {
      const group = carried.get(tables) ?? { at: kept.length, table: tables, lines: [] };
      group.lines.push(line);
      carried.set(tables, group);
    } else if (!found.removed.has(index) && !isConcordComment(line)) {
      if (isHeader(line)) tables += 1;
      keepLine(kept, line);
    }
  }
  return {
    lines: kept.map((line) => line.text),
    spot,
    carried: [...carried.values()],
    taken: keysByTable(kept),
  };
}

/** `lines` joined, without blank lines at either end. */
function joinTrimmed(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') start += 1;
  while (end > start && lines[end - 1]?.trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/**
 * Idempotently add Concord's lifecycle hooks to a Codex TOML config.
 *
 * Hooks are found by content, since Codex moves the marker comments. The block
 * goes where the first hook was, else at the end: a table boundary either way,
 * so no key is re-parented.
 */
export function upsertCodexHooks(existing: string | undefined): string {
  return inLineEnding(existing ?? '', addHooksBlock);
}

function addHooksBlock(source: string): string {
  const { lines, spot, carried } = stripConcordHooks(source);
  const at = spot ?? lines.length;
  // Lines that sat after an end marker stay after it, where TOML read them.
  const after = mergeCarried(carried.flatMap((group) => group.lines));
  const parts = [
    joinTrimmed(lines.slice(0, at)),
    [CONCORD_HOOKS_BLOCK, ...after].join('\n'),
    joinTrimmed(lines.slice(at)),
  ];
  return `${parts.filter((part) => part !== '').join('\n\n')}\n`;
}

/**
 * Write Concord's hooks into Codex's user-global `config.toml`. Returns the
 * absolute path written.
 */
export function installCodexHooks(env: NodeJS.ProcessEnv = process.env): string {
  const fullPath = codexConfigFile(env);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, upsertCodexHooks(existing));
  return fullPath;
}

/**
 * Register Concord in Codex's user-global `config.toml` (created if absent),
 * preserving the rest of the file. Returns the absolute path written, since it
 * lies outside the repo and callers surface that to the user.
 */
export function installCodexMcpConfig(env: NodeJS.ProcessEnv = process.env): string {
  const fullPath = codexConfigFile(env);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, upsertCodexMcpServer(existing));
  return fullPath;
}

/**
 * Remove `[mcp_servers.concord]` and every table nested under it. Codex writes
 * subtables such as `[mcp_servers.concord.tools.start_work]` when a tool is
 * always-approved; leaving one behind still defines the server, now with no
 * transport, and Codex refuses to load the whole config.
 */
export function removeCodexMcpServer(source: string): string {
  return inLineEnding(source, removeServerTables);
}

/** Each table's own lines, so the comments above the table after it stay. */
function removeServerTables(source: string): string {
  const lines = [...tomlLines(source)];
  const removed = new Set<number>();
  for (const [index, line] of lines.entries()) {
    const table = headerKey(line);
    if (table !== undefined && CONCORD_TOML_KEY.test(table)) {
      removeRange(removed, index, tableEnd(lines, index));
    }
  }
  const kept: TomlLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (!removed.has(index)) keepLine(kept, line);
  }
  return kept
    .map((line) => line.text)
    .join('\n')
    .replace(/^\n+/u, '');
}

/**
 * Remove only Concord-owned Codex config while preserving hook trust tables.
 * The server table goes first: once the hooks are gone, the lines after their
 * end marker would read as part of whatever table is above them.
 */
export function uninstallCodexConfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fullPath = codexConfigFile(env);
  if (!existsSync(fullPath)) return undefined;
  const uninstalled = inLineEnding(readFileSync(fullPath, 'utf8'), (text) => {
    const { lines, carried, taken } = stripConcordHooks(removeServerTables(text));
    // Lines that sat after an end marker stay where they were, merged per table.
    const kept = [...lines];
    // A line that would clash with a key its new table sets is dropped: Codex ignored it.
    for (const group of carried.reverse()) {
      kept.splice(group.at, 0, ...mergeCarried(group.lines, taken[group.table]));
    }
    const trimmed = kept.join('\n').replace(/^\n+/u, '').replace(/\n*$/u, '');
    return trimmed === '' ? '' : `${trimmed}\n`;
  });
  writeFileSync(fullPath, uninstalled);
  return fullPath;
}
