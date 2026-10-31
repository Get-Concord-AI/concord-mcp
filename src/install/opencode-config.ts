import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { z } from 'zod';

import { CONCORD_SERVER_COMMAND, McpConfigParseError } from './mcp-config.js';

const SERVER_KEY = 'concord';
const PACKAGE_NAME = '@concord-ai/concord-mcp';
const CONFIG_FILES = ['opencode.json', 'opencode.jsonc'] as const;

const configSchema = z
  .object({
    mcp: z
      .object({
        servers: z.record(z.string(), z.unknown()).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const entrySchema = z
  .object({
    type: z.literal('local'),
    command: z.array(z.string()),
    environment: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional(),
  })
  .loose();

const ownedEntrySchema = z
  .object({
    type: z.literal('local'),
    command: z.tuple([z.literal(CONCORD_SERVER_COMMAND)]),
    environment: z
      .object({
        CONCORD_AGENT_KIND: z.literal('opencode'),
      })
      .strict(),
    disabled: z.boolean().optional(),
  })
  .strict();

export type OpenCodeConfigState =
  | { kind: 'missing'; relPath: string }
  | { kind: 'configured'; relPath: string }
  | { kind: 'disabled'; relPath: string }
  | { kind: 'custom'; relPath: string };

interface ConfigTarget {
  relPath: string;
  fullPath: string;
}

function parseConfig(text: string, relPath: string): z.infer<typeof configSchema> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) throw new McpConfigParseError(relPath, 'is not valid JSONC');
  const config = configSchema.safeParse(parsed);
  if (!config.success) throw new McpConfigParseError(relPath, 'has an invalid MCP configuration');
  return config.data;
}

function configTarget(repoRoot: string): ConfigTarget {
  const existing = CONFIG_FILES.filter((relPath) => existsSync(join(repoRoot, relPath)));
  if (existing.length < 2) {
    const relPath = existing[0] ?? CONFIG_FILES[0];
    return { relPath, fullPath: join(repoRoot, relPath) };
  }

  const configured = existing.filter((relPath) => {
    const fullPath = join(repoRoot, relPath);
    if (!lstatSync(fullPath).isFile()) {
      throw new McpConfigParseError(relPath, 'must be a regular file');
    }
    const text = readFileSync(fullPath, 'utf8');
    return parseConfig(text, relPath).mcp?.servers?.[SERVER_KEY] !== undefined;
  });
  if (configured.length > 1) {
    throw new McpConfigParseError(
      existing.join(' and '),
      'both define a Concord MCP server; keep it in one OpenCode config file',
    );
  }

  const relPath = configured[0] ?? CONFIG_FILES[0];
  return { relPath, fullPath: join(repoRoot, relPath) };
}

function formatOptions(text: string) {
  return {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
    },
  };
}

function edit(text: string, path: (string | number)[], value: unknown, relPath: string): string {
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) throw new McpConfigParseError(relPath, 'is not valid JSONC');
  return applyEdits(text, modify(text, path, value, formatOptions(text)));
}

function concordEntry(text: string, relPath: string): unknown {
  return parseConfig(text, relPath).mcp?.servers?.[SERVER_KEY];
}

function isOwnedEntry(entry: unknown): entry is z.infer<typeof ownedEntrySchema> {
  return ownedEntrySchema.safeParse(entry).success;
}

function isConcordCommand(entry: unknown): boolean {
  const parsed = entrySchema.safeParse(entry);
  return (
    parsed.success &&
    (parsed.data.command.includes(CONCORD_SERVER_COMMAND) ||
      parsed.data.command.includes(PACKAGE_NAME))
  );
}

function updatedText(existing: string | undefined, relPath: string): string {
  const original = existing === undefined || existing.trim() === '' ? '{}\n' : existing;
  const current = concordEntry(original, relPath);
  if (current !== undefined && !isOwnedEntry(current)) return original;

  const root = ['mcp', 'servers', SERVER_KEY];
  const entry = {
    type: 'local',
    command: [CONCORD_SERVER_COMMAND],
    environment: {
      CONCORD_AGENT_KIND: 'opencode',
    },
  };

  let updated = original;
  if (current === undefined) {
    updated = edit(updated, root, entry, relPath);
  } else {
    updated = edit(updated, [...root, 'type'], entry.type, relPath);
    updated = edit(updated, [...root, 'command'], entry.command, relPath);
    updated = edit(updated, [...root, 'environment', 'CONCORD_AGENT_KIND'], 'opencode', relPath);
    if (isOwnedEntry(current) && current.disabled === true) {
      updated = edit(updated, [...root, 'disabled'], false, relPath);
    }
  }
  return updated.endsWith('\n') ? updated : `${updated}\n`;
}

/** Add Concord to OpenCode V2 config while retaining JSONC comments and settings. */
export function upsertOpenCodeMcpServer(
  existing: string | undefined,
  relPath = 'opencode.json',
): string {
  return updatedText(existing, relPath);
}

/** Inspect this repository's OpenCode MCP entry without starting an MCP server. */
export function inspectOpenCodeMcpConfig(repoRoot: string): OpenCodeConfigState {
  const target = configTarget(repoRoot);
  if (!existsSync(target.fullPath)) return { kind: 'missing', relPath: target.relPath };

  const entry = concordEntry(readFileSync(target.fullPath, 'utf8'), target.relPath);
  if (entry === undefined) return { kind: 'missing', relPath: target.relPath };
  if (!isConcordCommand(entry)) return { kind: 'custom', relPath: target.relPath };

  const parsed = entrySchema.parse(entry);
  return parsed.disabled === true
    ? { kind: 'disabled', relPath: target.relPath }
    : { kind: 'configured', relPath: target.relPath };
}

/** Write only the repository-scoped config file; OpenCode loads AGENTS.md instructions itself. */
export function installOpenCodeMcpConfig(repoRoot: string): string {
  const target = configTarget(repoRoot);
  const stat = lstatSync(target.fullPath, { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isFile()) {
    throw new McpConfigParseError(target.relPath, 'must be a regular file');
  }

  const existing = stat === undefined ? undefined : readFileSync(target.fullPath, 'utf8');
  const updated = updatedText(existing, target.relPath);
  if (updated !== existing) {
    mkdirSync(dirname(target.fullPath), { recursive: true });
    writeFileSync(target.fullPath, updated);
  }
  return target.relPath;
}

/** Remove only an exact Concord-owned entry; custom entries and other settings remain untouched. */
export function removeOpenCodeMcpConfig(repoRoot: string): string | undefined {
  const target = configTarget(repoRoot);
  const stat = lstatSync(target.fullPath, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isFile()) throw new McpConfigParseError(target.relPath, 'must be a regular file');
  const existing = readFileSync(target.fullPath, 'utf8');
  const entry = concordEntry(existing, target.relPath);
  if (entry === undefined || !isOwnedEntry(entry)) return undefined;

  const updated = edit(existing, ['mcp', 'servers', SERVER_KEY], undefined, target.relPath);
  writeFileSync(target.fullPath, updated.endsWith('\n') ? updated : `${updated}\n`);
  return target.relPath;
}
