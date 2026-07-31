import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/** The key Concord registers itself under in an `mcpServers` map. */
export const CONCORD_SERVER_KEY = 'concord';
/** The binary clients spawn to run the stdio MCP server. */
export const CONCORD_SERVER_COMMAND = 'concord-mcp';

/** Repo-relative config paths that share the `mcpServers` JSON shape. */
const JSON_TARGETS: readonly string[] = ['.mcp.json', join('.cursor', 'mcp.json')];

const mcpConfigSchema = z.object({ mcpServers: z.record(z.unknown()).optional() }).passthrough();

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

/**
 * Idempotently add Concord's server entry to an `mcpServers` config string.
 * Every other server and every unrelated top-level key is preserved, and
 * passing the previous output back in is a no-op.
 */
export function upsertMcpServer(existing: string | undefined, repoRoot: string): string {
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
        env: { CONCORD_REPO_ROOT: repoRoot },
      },
    },
  };
  return `${JSON.stringify(next, null, 2)}\n`;
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

/**
 * Register Concord in every JSON-shaped client config under `repoRoot`
 * (Claude Code's `.mcp.json` and Cursor's `.cursor/mcp.json`), creating each
 * file if absent. Returns the relative paths written.
 */
export function installMcpConfigs(repoRoot: string): string[] {
  return JSON_TARGETS.map((relPath) => writeMcpConfig(repoRoot, relPath));
}
