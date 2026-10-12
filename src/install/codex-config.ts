import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CONCORD_SERVER_COMMAND } from './mcp-config.js';

/** The TOML table Codex reads Concord's server definition from. */
export const CODEX_SECTION_HEADER = '[mcp_servers.concord]';

/** The nested env table Concord writes its managed keys into. */
const CODEX_ENV_HEADER = '[mcp_servers.concord.env]';

/** Matches any TOML table header, which terminates the preceding table. */
const TABLE_HEADER = /^\s*\[/u;

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

/**
 * Idempotently add Concord's `[mcp_servers.concord]` table to a Codex TOML
 * config. This splices the table by line range rather than parsing and
 * re-serializing, so unrelated tables — and the comments and formatting around
 * them, which a round-trip through a parser would discard — survive verbatim.
 *
 * The agent kind is written into a `[mcp_servers.concord.env]` table rather
 * than as a dotted `env.` key: if the user already has that subtable, a dotted
 * key would define the same table twice and make the whole file invalid TOML,
 * which stops Codex from loading its config at all.
 */
export function upsertCodexMcpServer(existing: string | undefined): string {
  const source = existing ?? '';
  if (source.trim() === '') {
    return `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"\n\n${CODEX_ENV_HEADER}\nCONCORD_AGENT_KIND = "codex"\n`;
  }

  const lines = source.split('\n');

  // Locate an existing env table anywhere in the file and capture its keys, so
  // a table separated from the server by another table is still merged rather
  // than duplicated (a duplicate would be invalid TOML).
  const envHeaderIndex = lines.findIndex((line) => line.trim() === CODEX_ENV_HEADER);
  const preservedEnvKeys: string[] = [];
  const removed = new Set<number>();
  if (envHeaderIndex !== -1) {
    removed.add(envHeaderIndex);
    let envEnd = lines.length;
    for (let index = envHeaderIndex + 1; index < lines.length; index += 1) {
      if (TABLE_HEADER.test(lines[index] ?? '')) {
        envEnd = index;
        break;
      }
    }
    for (let index = envHeaderIndex + 1; index < envEnd; index += 1) {
      removed.add(index);
      const line = lines[index] ?? '';
      if (line.trim() !== '' && !/^\s*"?CONCORD_AGENT_KIND"?\s*=/u.test(line)) {
        preservedEnvKeys.push(line);
      }
    }
  }

  // Remove the existing server table (and anything up to the next header) so
  // it is re-emitted cleanly with its env table adjacent.
  const serverIndex = lines.findIndex((line) => line.trim() === CODEX_SECTION_HEADER);
  if (serverIndex !== -1) {
    removed.add(serverIndex);
    for (let index = serverIndex + 1; index < lines.length; index += 1) {
      if (TABLE_HEADER.test(lines[index] ?? '')) break;
      removed.add(index);
    }
  }

  const kept = lines.filter((_, index) => !removed.has(index));
  // Collapse the blank runs the removals leave behind.
  const base = kept
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+/u, '')
    .replace(/\n+$/u, '');

  const serverSection = `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"\n`;
  const envBody = [...preservedEnvKeys, 'CONCORD_AGENT_KIND = "codex"'].join('\n');
  const block = `${serverSection}\n${CODEX_ENV_HEADER}\n${envBody}\n`;
  return base === '' ? block : `${base}\n\n${block}`;
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

function removeTable(source: string, header: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return source;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (TABLE_HEADER.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)]
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
  writeFileSync(
    fullPath,
    removeTable(removeTable(withoutHooks, CODEX_ENV_HEADER), CODEX_SECTION_HEADER),
  );
  return fullPath;
}
