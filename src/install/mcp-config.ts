import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/** The key Concord registers itself under in an `mcpServers` map. */
export const CONCORD_SERVER_KEY = 'concord';
/** The binary clients spawn to run the stdio MCP server. */
export const CONCORD_SERVER_COMMAND = 'concord-mcp';

/** Repo-relative config paths that share the `mcpServers` JSON shape. */
const JSON_TARGETS: readonly string[] = ['.mcp.json', join('.cursor', 'mcp.json')];
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
  constructor(readonly relPath: string) {
    super(`${relPath} is not valid JSON — fix or remove it, then re-run.`);
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
export function upsertMcpServer(existing: string | undefined, repoRoot?: string): string {
  const source: unknown =
    existing === undefined || existing.trim() === '' ? {} : JSON.parse(existing);
  const config = mcpConfigSchema.parse(source);
  const servers = config.mcpServers ?? {};

  const next = {
    ...config,
    mcpServers: {
      ...servers,
      [CONCORD_SERVER_KEY]: {
        command: CONCORD_SERVER_COMMAND,
        ...(repoRoot === undefined ? {} : { env: { CONCORD_REPO_ROOT: repoRoot } }),
      },
    },
  };
  return `${JSON.stringify(next, null, 2)}\n`;
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
export function upsertGrokMcpServer(existing: string | undefined, repoRoot?: string): string {
  const base = removeGrokMcpServer(existing ?? '');
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
  const lines = existing.split(/\r?\n/u);
  const preserved: string[] = [];
  let inOwnedFence = false;
  let inConcordTable = false;

  for (const line of lines) {
    if (line.trim() === GROK_FENCE_START) {
      inOwnedFence = true;
      inConcordTable = false;
      continue;
    }
    if (inOwnedFence) {
      if (line.trim() === GROK_FENCE_END) inOwnedFence = false;
      continue;
    }

    const table = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line)?.[1]?.trim();
    if (table !== undefined) {
      inConcordTable = table === 'mcp_servers.concord' || table === 'mcp_servers.concord.env';
      if (inConcordTable) continue;
    }
    if (!inConcordTable) preserved.push(line);
  }

  return preserved.join('\n').trimEnd();
}

function writeMcpConfig(repoRoot: string, relPath: string): string {
  const fullPath = join(repoRoot, relPath);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;

  let updated: string;
  try {
    updated = upsertMcpServer(existing, repoRoot);
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
 * Claude Code, Cursor, Gemini CLI, and Grok Build. Codex uses its user-scoped
 * TOML installer because that harness does not expose a project MCP file.
 */
export function installMcpConfigs(repoRoot: string): string[] {
  return [
    ...JSON_TARGETS.map((relPath) => writeMcpConfig(repoRoot, relPath)),
    writeGeminiConfig(repoRoot),
    writeGrokMcpConfig(repoRoot),
  ];
}

/**
 * Remove a user-scoped Cursor Concord server that would shadow the repository-
 * pinned `.cursor/mcp.json` entry. Cursor identifies both registrations by the
 * same server name and may select `user-concord`, whose cwd is unrelated to the
 * open repository. Every other global MCP server and top-level setting is
 * preserved. Returns the absolute path only when a migration was written.
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
  if (servers === undefined || !(CONCORD_SERVER_KEY in servers)) return undefined;

  const remaining = Object.fromEntries(
    Object.entries(servers).filter(([key]) => key !== CONCORD_SERVER_KEY),
  );
  const updated = { ...config, mcpServers: remaining };
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
  return path;
}
