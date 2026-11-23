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

/** Blank and comment lines belong to what follows them. */
function isDecoration(line: TomlLine | undefined): boolean {
  return (
    line !== undefined &&
    !line.inString &&
    (line.text.trim() === '' || COMMENT_LINE.test(line.text))
  );
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

/**
 * Codex passes its session id on stdin rather than in the environment, so every
 * hook reads the payload to work out which agent it is.
 */
const CONCORD_HOOKS_BLOCK = `${HOOKS_BEGIN}
# Delivers Concord messages from other agents into this session. Remove this
# block (markers included) to opt out.
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "concord inbox register --from-hook --provider codex"

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "concord inbox drain --from-hook --provider codex --format post-tool-use"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "concord inbox drain --from-hook --provider codex --format stop"
${HOOKS_END}`;

/** The table headers this block owns. Anything else inside it came from Codex. */
const OWNED_HEADERS = new Set([
  '[[hooks.SessionStart]]',
  '[[hooks.SessionStart.hooks]]',
  '[[hooks.PostToolUse]]',
  '[[hooks.PostToolUse.hooks]]',
  '[[hooks.Stop]]',
  '[[hooks.Stop.hooks]]',
]);

const LEGACY_CONCORD_HOOKS = [
  {
    parent: '[[hooks.SessionStart]]',
    child: '[[hooks.SessionStart.hooks]]',
    command: 'command = "concord inbox register --from-hook --provider codex"',
  },
  {
    parent: '[[hooks.PostToolUse]]',
    child: '[[hooks.PostToolUse.hooks]]',
    command: 'command = "concord inbox drain --from-hook --provider codex --format post-tool-use"',
  },
  {
    parent: '[[hooks.Stop]]',
    child: '[[hooks.Stop.hooks]]',
    command: 'command = "concord inbox drain --from-hook --provider codex --format stop"',
  },
] as const;

/** Remove only the exact unfenced hook tables written by older Concord builds. */
function removeLegacyConcordHooks(source: string): string {
  const lines = source.split('\n');
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const legacy = LEGACY_CONCORD_HOOKS.find((hook) => lines[index]?.trim() === hook.parent);
    if (legacy === undefined) {
      kept.push(lines[index] ?? '');
      index += 1;
      continue;
    }

    let child = index + 1;
    while (child < lines.length && lines[child]?.trim() === '') child += 1;
    if (lines[child]?.trim() !== legacy.child) {
      kept.push(lines[index] ?? '');
      index += 1;
      continue;
    }

    let end = child + 1;
    while (end < lines.length && !TABLE_HEADER.test(lines[end] ?? '')) end += 1;
    const body = lines.slice(child + 1, end).map((line) => line.trim());
    if (!body.includes('type = "command"') || !body.includes(legacy.command)) {
      kept.push(lines[index] ?? '');
      index += 1;
      continue;
    }
    index = end;
    while (index < lines.length && lines[index]?.trim() === '') index += 1;
  }
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n');
}

/**
 * Split a previous block into the part we wrote and any part Codex appended.
 *
 * Codex records hook trust as `[hooks.state]` tables written to the end of
 * config.toml, which lands inside our fence because our end marker is the last
 * line. Rewriting the whole block would delete that trust and silently
 * re-prompt the user — so keep everything from the first table header we do not
 * own onwards.
 */
function foreignTail(block: string): string {
  const lines = block.split('\n');
  const index = lines.findIndex(
    (line) => line.trimStart().startsWith('[') && !OWNED_HEADERS.has(line.trim()),
  );
  return index === -1 ? '' : lines.slice(index).join('\n').replace(/\n*$/u, '');
}

/**
 * Idempotently add Concord's lifecycle hooks to a Codex TOML config.
 *
 * The block is fenced by marker comments and appended at the end of the file.
 * Appending matters: TOML array-of-tables belong to whichever table header
 * precedes them, so splicing this into the middle would silently re-parent any
 * following keys.
 */
export function upsertCodexHooks(existing: string | undefined): string {
  const source = existing ?? '';
  const begin = source.indexOf(HOOKS_BEGIN);
  const end = source.indexOf(HOOKS_END);
  if (begin !== -1 && end > begin) {
    const head = removeLegacyConcordHooks(source.slice(0, begin));
    const tail = removeLegacyConcordHooks(source.slice(end + HOOKS_END.length));
    const preserved = foreignTail(source.slice(begin + HOOKS_BEGIN.length, end));
    const body = preserved === '' ? CONCORD_HOOKS_BLOCK : `${CONCORD_HOOKS_BLOCK}\n\n${preserved}`;
    return `${head}${body}${tail}`;
  }
  const base = removeLegacyConcordHooks(source).replace(/\n*$/u, '');
  return base === '' ? `${CONCORD_HOOKS_BLOCK}\n` : `${base}\n\n${CONCORD_HOOKS_BLOCK}\n`;
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
  const kept: string[] = [];
  let inConcordTable = false;
  for (const { text, inString } of tomlLines(source)) {
    const table = inString ? undefined : /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/u.exec(text)?.[1];
    if (table !== undefined) inConcordTable = CONCORD_TOML_KEY.test(tomlKeyPath(table));
    if (!inConcordTable) kept.push(text);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+/u, '');
}

/** Remove only Concord-owned Codex config while preserving hook trust tables. */
export function uninstallCodexConfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fullPath = codexConfigFile(env);
  if (!existsSync(fullPath)) return undefined;
  const source = readFileSync(fullPath, 'utf8');
  const begin = source.indexOf(HOOKS_BEGIN);
  const end = source.indexOf(HOOKS_END);
  let withoutHooks = source;
  if (begin !== -1 && end > begin) {
    const preserved = foreignTail(source.slice(begin + HOOKS_BEGIN.length, end));
    withoutHooks =
      source.slice(0, begin) +
      (preserved === '' ? '' : `${preserved}\n`) +
      source.slice(end + HOOKS_END.length);
  }
  writeFileSync(fullPath, removeCodexMcpServer(withoutHooks));
  return fullPath;
}
