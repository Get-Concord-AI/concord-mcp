import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { inlineTableKeys, tomlKeyPath, tomlLines } from './toml-lines.js';

/** The key Concord registers itself under in an `mcpServers` map. */
export const CONCORD_SERVER_KEY = 'concord';
/** The binary clients spawn to run the stdio MCP server. */
export const CONCORD_SERVER_COMMAND = 'concord-mcp';

/** Repo-relative config paths that share the `mcpServers` JSON shape. */
const JSON_TARGETS: readonly string[] = [
  '.mcp.json',
  join('.cursor', 'mcp.json'),
  join('.agents', 'mcp_config.json'),
  join('.github', 'mcp.json'),
];
/** Harness kind each project file pins, for files only one harness reads. */
const PINNED_KINDS: ReadonlyMap<string, string> = new Map([
  [join('.agents', 'mcp_config.json'), 'antigravity'],
  [join('.github', 'mcp.json'), 'copilot-cli'],
]);
const GEMINI_CONFIG_PATH = join('.gemini', 'settings.json');
const GROK_CONFIG_PATH = join('.grok', 'config.toml');
const GROK_FENCE_START = '# concord:mcp-start';
const GROK_FENCE_END = '# concord:mcp-end';

const mcpConfigSchema = z
  .object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
  .loose();
const looseObjectSchema = z.record(z.string(), z.unknown());

/**
 * Thrown when an existing config file cannot be parsed. The caller reports this
 * and leaves the file untouched rather than overwriting hand-written config.
 */
export class McpConfigParseError extends Error {
  constructor(
    readonly relPath: string,
    problem = 'is not valid JSON',
  ) {
    super(`${relPath} ${problem} — fix or remove it, then re-run.`);
    this.name = 'McpConfigParseError';
  }
}

function configuredHome(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env['HOME']?.trim();
  if (configured !== undefined && configured !== '') return configured;
  const profile = env['USERPROFILE']?.trim();
  return profile === undefined || profile === '' ? undefined : profile;
}

/**
 * Idempotently add Concord's server entry to an `mcpServers` config string.
 * Every other server and every unrelated top-level key is preserved, and
 * passing the previous output back in is a no-op. Without `repoRoot` the entry
 * is a user-level one, which finds the repository from where it is started.
 */
export function upsertMcpServer(
  existing: string | undefined,
  repoRoot?: string,
  extraEnv?: Record<string, string>,
): string {
  const source: unknown =
    existing === undefined || existing.trim() === '' ? {} : JSON.parse(existing);
  const config = mcpConfigSchema.parse(source);
  const servers = config.mcpServers ?? {};

  const env = {
    ...(repoRoot === undefined ? {} : { CONCORD_REPO_ROOT: repoRoot }),
    ...(extraEnv ?? {}),
  };

  const next = {
    ...config,
    mcpServers: {
      ...servers,
      [CONCORD_SERVER_KEY]: {
        command: CONCORD_SERVER_COMMAND,
        ...(Object.keys(env).length === 0 ? {} : { env }),
      },
    },
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** Whether an `mcpServers` config string already registers Concord. */
export function hasMcpServer(existing: string): boolean {
  try {
    if (existing.trim() === '') return false;
    return CONCORD_SERVER_KEY in (mcpConfigSchema.parse(JSON.parse(existing)).mcpServers ?? {});
  } catch {
    return false;
  }
}

/** Matches Concord's `mcp_servers.concord` TOML key path and every key or subtable under it. */
export const CONCORD_TOML_KEY = /^mcp_servers\.concord(?:\.|$)/u;

/** Each key path Grok TOML assigns or opens as a table, spacing and quotes removed. */
function* grokKeyPaths(existing: string): Generator<{ path: string; header: boolean }> {
  let table = '';
  for (const { text, inString } of tomlLines(existing)) {
    // A line inside a multi-line string is text, however much it looks like TOML.
    if (inString) continue;
    const header = /^\s*\[([^\]]+)\]/u.exec(text)?.[1];
    if (header !== undefined) {
      table = tomlKeyPath(header);
      yield { path: table, header: true };
      continue;
    }
    const assignment = /^\s*([^=#]+?)\s*=/u.exec(text);
    const key = assignment?.[1];
    if (assignment === null || key === undefined) continue;
    const path = tomlKeyPath(table === '' ? key : `${table}.${key}`);
    yield { path, header: false };
    for (const inner of inlineTableKeys(text.slice(assignment[0].length))) {
      yield { path: `${path}.${inner}`, header: false };
    }
  }
}

/** Whether Grok TOML registers Concord in any spelling: a table (quoted or not), dotted keys, or inline. */
export function hasGrokMcpServer(existing: string): boolean {
  return [...grokKeyPaths(existing)].some(({ path }) => CONCORD_TOML_KEY.test(path));
}

/** Remove Concord's entry from an `mcpServers` config string, keeping the rest. */
export function removeMcpServer(existing: string): string {
  const config = mcpConfigSchema.parse(JSON.parse(existing));
  const servers = Object.fromEntries(
    Object.entries(config.mcpServers ?? {}).filter(([key]) => key !== CONCORD_SERVER_KEY),
  );
  return `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
}

/**
 * Register Concord and make Gemini return native background shell completions
 * to the agent. Existing Gemini settings, shell options, and MCP servers are
 * preserved. The `inject` behavior is what turns a completed one-shot inbox
 * watch into a new Gemini turn while the session is otherwise idle. Gemini's
 * idle injection effect is gated separately by experimental model steering.
 */
export function upsertGeminiSettings(existing: string | undefined, repoRoot?: string): string {
  const withServer = looseObjectSchema.parse(JSON.parse(upsertMcpServer(existing, repoRoot)));
  const currentTools = looseObjectSchema.safeParse(withServer['tools']);
  const tools = currentTools.success ? currentTools.data : {};
  const currentShell = looseObjectSchema.safeParse(tools['shell']);
  const shell = currentShell.success ? currentShell.data : {};
  const currentExperimental = looseObjectSchema.safeParse(withServer['experimental']);
  const experimental = currentExperimental.success ? currentExperimental.data : {};
  return `${JSON.stringify(
    {
      ...withServer,
      tools: {
        ...tools,
        shell: { ...shell, backgroundCompletionBehavior: 'inject' },
      },
      experimental: { ...experimental, modelSteering: true },
    },
    null,
    2,
  )}\n`;
}

/**
 * Idempotently own only Grok's `mcp_servers.concord` TOML tables. Grok uses a
 * project-local TOML file rather than the JSON shape shared by the other
 * harnesses, so setup preserves every unrelated line and replaces either a
 * previous Concord fence or Grok CLI-generated Concord tables.
 */
export function upsertGrokMcpServer(
  existing: string | undefined,
  repoRoot?: string,
  configPath = GROK_CONFIG_PATH,
): string {
  const base = removeGrokMcpServer(existing ?? '');
  // TOML cannot add a `[mcp_servers.concord]` table to an inline `mcp_servers = { ... }`.
  if ([...grokKeyPaths(base)].some(({ path, header }) => !header && path === 'mcp_servers')) {
    throw new McpConfigParseError(
      configPath,
      'sets mcp_servers as an inline table, which Concord cannot add to',
    );
  }
  const block = [
    GROK_FENCE_START,
    '[mcp_servers.concord]',
    `command = ${JSON.stringify(CONCORD_SERVER_COMMAND)}`,
    'args = []',
    'enabled = true',
    ...(repoRoot === undefined
      ? []
      : ['', '[mcp_servers.concord.env]', `CONCORD_REPO_ROOT = ${JSON.stringify(repoRoot)}`]),
    GROK_FENCE_END,
  ].join('\n');
  return `${base}${base === '' ? '' : '\n\n'}${block}\n`;
}

/** Grok TOML without Concord's fence or tables, every other line kept. */
export function removeGrokMcpServer(existing: string): string {
  const preserved: string[] = [];
  let inOwnedFence = false;
  let inConcordTable = false;

  for (const { text: line, inString } of tomlLines(existing)) {
    if (!inString && line.trim() === GROK_FENCE_START) {
      inOwnedFence = true;
      inConcordTable = false;
      continue;
    }
    if (inOwnedFence) {
      if (!inString && line.trim() === GROK_FENCE_END) inOwnedFence = false;
      continue;
    }

    const table = inString ? undefined : /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line)?.[1];
    if (table !== undefined) {
      inConcordTable = CONCORD_TOML_KEY.test(tomlKeyPath(table));
      if (inConcordTable) continue;
    }
    if (!inConcordTable) preserved.push(line);
  }

  return preserved.join('\n').trimEnd();
}

function writeMcpConfig(repoRoot: string, relPath: string): string {
  const fullPath = join(repoRoot, relPath);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;

  if (existing !== undefined && hasMcpServer(existing) && !isConcordServerOwned(existing)) {
    return relPath;
  }

  let updated: string;
  try {
    const kind = PINNED_KINDS.get(relPath);
    updated = upsertMcpServer(
      existing,
      repoRoot,
      kind === undefined ? undefined : { CONCORD_AGENT_KIND: kind },
    );
  } catch {
    throw new McpConfigParseError(relPath);
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, updated);
  return relPath;
}

function writeGrokMcpConfig(repoRoot: string): string {
  const fullPath = join(repoRoot, GROK_CONFIG_PATH);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, upsertGrokMcpServer(existing, repoRoot));
  return GROK_CONFIG_PATH;
}

function writeGeminiConfig(repoRoot: string): string {
  const fullPath = join(repoRoot, GEMINI_CONFIG_PATH);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
  let updated: string;
  try {
    updated = upsertGeminiSettings(existing, repoRoot);
  } catch {
    throw new McpConfigParseError(GEMINI_CONFIG_PATH);
  }
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, updated);
  return GEMINI_CONFIG_PATH;
}

/**
 * Register Concord in every project-scoped client config under `repoRoot`:
 * Claude Code, Cursor, Antigravity, Copilot CLI, Gemini CLI, and Grok Build.
 * Codex uses its user-scoped TOML installer because that harness does not
 * expose a project MCP file.
 */
export function installMcpConfigs(repoRoot: string): string[] {
  return [
    ...JSON_TARGETS.map((relPath) => writeMcpConfig(repoRoot, relPath)),
    writeGeminiConfig(repoRoot),
    writeGrokMcpConfig(repoRoot),
  ];
}

/** The published package an older install would have run through a runner. */
const CONCORD_PACKAGE_NAME = '@concord-ai/concord-mcp';

/**
 * Whether a `concord` server entry is one Concord wrote and may therefore be
 * migrated away. Concord registers the bare `concord-mcp` command; older
 * installs named the published package in a runner's arguments, as
 * `@concord-ai/concord-mcp` optionally followed by a version. A path that
 * merely contains that text is the user's own wrapper and is left alone.
 */
export function isConcordWrittenEntry(entry: unknown): boolean {
  const parsed = z
    .object({
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .loose()
    .safeParse(entry);
  if (!parsed.success) return false;
  // If the user specified custom arguments, it is a custom entry unless matching the runner shape.
  if (parsed.data.args !== undefined && parsed.data.args.length > 0) {
    const isRunner = parsed.data.args.some((arg) => isPackageSpec(arg, CONCORD_PACKAGE_NAME));
    if (!isRunner) return false;
  }
  // If the user specified custom environment variables (other than CONCORD_REPO_ROOT or CONCORD_AGENT_KIND), it is custom.
  const envKeys = Object.keys(parsed.data.env ?? {});
  if (envKeys.some((key) => key !== 'CONCORD_REPO_ROOT' && key !== 'CONCORD_AGENT_KIND')) {
    return false;
  }
  if (parsed.data.command === CONCORD_SERVER_COMMAND) return true;
  // A non-string argument means this is not a shape Concord writes, so the
  // whole entry is treated as the user's own rather than parsed further.
  return (parsed.data.args ?? []).some((arg) => isPackageSpec(arg, CONCORD_PACKAGE_NAME));
}

/** Whether an existing MCP config string contains a Concord server entry written by Concord. */
export function isConcordServerOwned(existing: string): boolean {
  try {
    if (existing.trim() === '') return false;
    const config = mcpConfigSchema.parse(JSON.parse(existing));
    const entry = config.mcpServers?.[CONCORD_SERVER_KEY];
    return entry !== undefined && isConcordWrittenEntry(entry);
  } catch {
    return false;
  }
}

/** Whether `arg` is exactly `name`, or `name@version` — not a path containing it. */
function isPackageSpec(arg: string, name: string): boolean {
  if (arg === name) return true;
  if (!arg.startsWith(`${name}@`)) return false;
  const version = arg.slice(name.length + 1);
  return version !== '' && !version.includes('/') && !version.includes('\\');
}

/**
 * Remove a user-scoped Cursor Concord server that would shadow the repository-
 * pinned `.cursor/mcp.json` entry. Cursor identifies both registrations by the
 * same server name and may select `user-concord`, whose cwd is unrelated to the
 * open repository. Only an entry Concord itself wrote is removed — a server the
 * user registered under the same name is left untouched. Every other global MCP
 * server and top-level setting is preserved. Returns the absolute path only
 * when a migration was written.
 */
export function removeGlobalCursorConcord(env: NodeJS.ProcessEnv): string | undefined {
  const home = configuredHome(env);
  if (home === undefined) return undefined;
  const path = join(home, '.cursor', 'mcp.json');
  if (!existsSync(path)) return undefined;

  const existing = readFileSync(path, 'utf8');
  let config: z.infer<typeof mcpConfigSchema>;
  try {
    config = mcpConfigSchema.parse(JSON.parse(existing));
  } catch {
    throw new McpConfigParseError(path);
  }
  const servers = config.mcpServers;
  const entry = servers?.[CONCORD_SERVER_KEY];
  if (servers === undefined || entry === undefined || !isConcordWrittenEntry(entry)) {
    return undefined;
  }

  const remaining = Object.fromEntries(
    Object.entries(servers).filter(([key]) => key !== CONCORD_SERVER_KEY),
  );
  const updated = { ...config, mcpServers: remaining };
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
  return path;
}
