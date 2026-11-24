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

/** Lines split on `\n` (keeping `\r`), flagged when inside a multi-line string. */
function sourceLines(source: string): TomlLine[] {
  const raw = source.split('\n');
  return Array.from(tomlLines(source), ({ inString }, index) => ({
    text: raw[index] ?? '',
    inString,
  }));
}

function isHeader(line: TomlLine): boolean {
  return !line.inString && TABLE_HEADER.test(line.text);
}

function isBlank(line: TomlLine | undefined): boolean {
  return line !== undefined && !line.inString && line.text.trim() === '';
}

/** Blank and comment lines belong to what follows them. */
function isDecoration(line: TomlLine | undefined): boolean {
  return isBlank(line) || (line !== undefined && !line.inString && COMMENT_LINE.test(line.text));
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
  const section = `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"\n`;
  const source = existing ?? '';
  if (source.trim() === '') {
    return section;
  }

  const lines = sourceLines(source);
  const found = lines.findIndex(
    (line) => !line.inString && line.text.trim() === CODEX_SECTION_HEADER,
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
  return !line.inString && CONCORD_COMMENTS.has(line.text.trim());
}

/** The key of an array-of-tables header such as `[[ hooks.Stop ]] # note`. */
function arrayTableKey(line: TomlLine | undefined): string | undefined {
  if (line === undefined || line.inString) return undefined;
  const key = /^\[\[([^\]]+)\]\]\s*(?:#.*)?$/u.exec(line.text.trim())?.[1];
  return key === undefined ? undefined : tomlKeyPath(key);
}

/** The key and string value a `key = "value"` line sets, ignoring a trailing comment. */
function stringEntry(line: TomlLine): { key: string; value: string } | undefined {
  if (line.inString) return undefined;
  const match = /^([\w-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/u.exec(line.text.trim());
  const key = match?.[1];
  const value = match?.[2] ?? match?.[3];
  return key === undefined || value === undefined ? undefined : { key, value };
}

/** The index past the entry headed at `entry`, if it runs exactly Concord's `command`. */
function concordEntryEnd(
  lines: readonly TomlLine[],
  entry: number,
  command: string,
): number | undefined {
  // Concord's comment lines, such as the end marker, are never part of its entry.
  let end = tableEnd(lines, entry);
  const marker = lines.findIndex(
    (line, index) => index > entry && index < end && isConcordComment(line),
  );
  if (marker !== -1) end = marker;

  const values = lines.slice(entry + 1, end).map(stringEntry);
  const ours =
    values.some((value) => value?.key === 'type' && value.value === 'command') &&
    values.some((value) => value?.key === 'command' && value.value === command);
  return ours ? end : undefined;
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
 * entry and no key such as `matcher`. `spot` is the first such group, unless a
 * user entry after it belongs to an earlier group that the block would steal.
 */
function concordHookLines(lines: readonly TomlLine[]): {
  removed: Set<number>;
  spot: number | undefined;
} {
  const removed = new Set<number>();
  const groups: HookGroup[] = [];
  const current = new Map<string, HookGroup>();
  const userEntries: number[] = [];
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
    const end = concordEntryEnd(lines, index, hook.command);
    if (end === undefined) {
      userEntries.push(index);
      continue;
    }
    removeRange(removed, index, end);
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
  if (first !== undefined && userEntries.some((entry) => entry > first)) spot = undefined;
  return { removed, spot };
}

/** `source` without Concord's hooks and comment lines, and where its first hook was. */
function stripConcordHooks(source: string): { lines: string[]; spot: number | undefined } {
  const lines = sourceLines(source);
  const { removed, spot: spotLine } = concordHookLines(lines);
  const kept: TomlLine[] = [];
  let spot: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (index === spotLine) spot = kept.length;
    if (!removed.has(index) && !isConcordComment(line)) keepLine(kept, line);
  }
  return { lines: kept.map((line) => line.text), spot };
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
  const { lines, spot } = stripConcordHooks(existing ?? '');
  const at = spot ?? lines.length;
  const parts = [
    joinTrimmed(lines.slice(0, at)),
    CONCORD_HOOKS_BLOCK,
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
  const kept: TomlLine[] = [];
  let inConcordTable = false;
  for (const line of tomlLines(source)) {
    const { text, inString } = line;
    const table = inString ? undefined : /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/u.exec(text)?.[1];
    if (table !== undefined) inConcordTable = CONCORD_TOML_KEY.test(tomlKeyPath(table));
    if (!inConcordTable) keepLine(kept, line);
  }
  return kept
    .map((line) => line.text)
    .join('\n')
    .replace(/^\n+/u, '');
}

/** Remove only Concord-owned Codex config while preserving hook trust tables. */
export function uninstallCodexConfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fullPath = codexConfigFile(env);
  if (!existsSync(fullPath)) return undefined;
  const { lines } = stripConcordHooks(readFileSync(fullPath, 'utf8'));
  writeFileSync(fullPath, removeCodexMcpServer(lines.join('\n')));
  return fullPath;
}
