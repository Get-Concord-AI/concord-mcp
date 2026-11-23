import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';
import {
  AGENT_KIND_ENV,
  CONCORD_PACKAGE_NAME,
  CONCORD_SERVER_COMMAND,
  CONCORD_SERVER_KEY,
  isPackageSpec,
} from './mcp-config.js';
import { spawnCommandSync } from './spawn-command.js';

/**
 * Kilo CLI's MCP registration.
 *
 * Kilo is an OpenCode fork: it owns `~/.config/kilo/kilo.jsonc` (JSONC, with
 * comments and trailing commas a user may add) plus the `kilo.json` /
 * `config.json` siblings the docs also accept. Registration therefore goes
 * through the harness's own writer — `kilo mcp add` is idempotent and leaves
 * every unrelated server and setting untouched — while status and removal
 * read and edit the files directly because `kilo mcp` has no remove command.
 *
 * The entry pins only the harness kind. Kilo passes no session id to MCP
 * servers — not in request metadata and not in the child environment — so a
 * session resolves its identity the way other session-less harnesses do:
 * `CONCORD_AGENT_ID` in the server's `environment`, or an id the caller
 * supplies. See docs/kilo.md.
 */

const COMMAND_TIMEOUT_MS = 30_000;

const kiloServerSchema = z
  .object({
    type: z.string().optional(),
    command: z.array(z.string()).optional(),
    url: z.string().optional(),
    enabled: z.boolean().optional(),
    environment: z.record(z.string(), z.string()).optional(),
  })
  .loose();

const kiloConfigSchema = z
  .object({
    mcp: z.record(z.string(), kiloServerSchema).optional(),
  })
  .loose();

type KiloServer = z.infer<typeof kiloServerSchema>;
type KiloConfig = z.infer<typeof kiloConfigSchema>;

/** Kilo's user config directory: `$XDG_CONFIG_HOME/kilo`, else `~/.config/kilo`. */
export function kiloConfigHome(env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  const base = xdg === undefined || xdg === '' ? join(userHome(env), '.config') : xdg;
  return join(base, 'kilo');
}

/**
 * Global config files Kilo reads under its config home. `kilo mcp add` writes
 * `kilo.jsonc`; the docs also accept `kilo.json` and `config.json`, so status
 * and removal check all three.
 */
const GLOBAL_CONFIG_NAMES = ['kilo.json', 'kilo.jsonc', 'config.json'] as const;

export function kiloGlobalConfigPaths(env: NodeJS.ProcessEnv): string[] {
  const home = kiloConfigHome(env);
  return GLOBAL_CONFIG_NAMES.map((name) => join(home, name));
}

/**
 * JSONC → JSON: drop `//` and `/* ... *\/` comments and trailing commas while
 * leaving string contents — including `//` inside a URL — untouched. Kilo
 * accepts comments in `kilo.jsonc`; Concord only needs to read the file and
 * remove its own entry.
 */
function jsoncToJson(source: string): string {
  const skipNoise = (from: number): number => {
    let cursor = from;
    for (;;) {
      while (/\s/u.test(source.charAt(cursor))) cursor += 1;
      if (source.charAt(cursor) === '/' && source.charAt(cursor + 1) === '/') {
        while (cursor < source.length && source.charAt(cursor) !== '\n') cursor += 1;
        continue;
      }
      if (source.charAt(cursor) === '/' && source.charAt(cursor + 1) === '*') {
        const end = source.indexOf('*/', cursor + 2);
        cursor = end === -1 ? source.length : end + 2;
        continue;
      }
      return cursor;
    }
  };

  let out = '';
  let index = 0;
  let quoted = false;
  while (index < source.length) {
    const char = source.charAt(index);
    if (quoted) {
      out += char;
      if (char === '\\') {
        out += source.charAt(index + 1);
        index += 2;
        continue;
      }
      if (char === '"') quoted = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && source.charAt(index + 1) === '/') {
      while (index < source.length && source.charAt(index) !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source.charAt(index + 1) === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === ',') {
      const next = skipNoise(index + 1);
      const following = source.charAt(next);
      if (following === '}' || following === ']') {
        index = next;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Parse one Kilo config file, tolerating the JSONC extras `kilo.jsonc` allows. */
function parseKiloConfig(text: string): KiloConfig {
  let source: unknown;
  try {
    source = JSON.parse(text);
  } catch {
    source = JSON.parse(jsoncToJson(text));
  }
  return kiloConfigSchema.parse(source);
}

/** Whether a `mcp.concord` entry is one Concord wrote and may therefore manage. */
function isKiloConcordEntry(entry: KiloServer): boolean {
  const launchesConcord = (entry.command ?? []).some(
    (arg) => arg === CONCORD_SERVER_COMMAND || isPackageSpec(arg, CONCORD_PACKAGE_NAME),
  );
  if (!launchesConcord) return false;
  // Environment the user added for their own purposes makes the entry theirs.
  return Object.keys(entry.environment ?? {}).every((key) => key.startsWith('CONCORD_'));
}

/** The `mcp.concord` entry of one config text when Concord owns it, else undefined. */
function ownedEntry(configText: string | undefined): KiloServer | undefined {
  if (configText === undefined || configText.trim() === '') return undefined;
  const entry = parseKiloConfig(configText).mcp?.[CONCORD_SERVER_KEY];
  return entry !== undefined && isKiloConcordEntry(entry) ? entry : undefined;
}

/**
 * Register (or refresh) Concord's MCP server through `kilo mcp add`, which
 * writes the global `kilo.jsonc` itself. The kind is pinned so a Kilo started
 * from another harness's shell cannot inherit that harness's session source.
 */
export function installKiloMcpConfig(executable: string, env: NodeJS.ProcessEnv): void {
  const result = spawnCommandSync(
    executable,
    [
      'mcp',
      'add',
      CONCORD_SERVER_KEY,
      '--env',
      `${AGENT_KIND_ENV}=kilo`,
      '--',
      CONCORD_SERVER_COMMAND,
    ],
    { env, timeout: COMMAND_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    const detail = result.error?.message ?? `${result.stdout}${result.stderr}`.trim();
    throw new Error(`kilo mcp add failed: ${detail.slice(0, 300)}`);
  }
}

/**
 * Whether a global Kilo config registers an enabled Concord server Concord
 * owns. 'unreadable' means a config file exists but cannot be parsed — it
 * takes priority over a working entry in a sibling file, since Kilo loads
 * all of them. A disabled (`enabled: false`) entry does not count as
 * installed.
 */
export function kiloMcpInstalled(env: NodeJS.ProcessEnv): boolean | 'unreadable' {
  let found = false;
  let unreadable = false;
  for (const path of kiloGlobalConfigPaths(env)) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      unreadable = true;
      continue;
    }
    let config: KiloConfig;
    try {
      config = parseKiloConfig(text);
    } catch {
      unreadable = true;
      continue;
    }
    const entry = config.mcp?.[CONCORD_SERVER_KEY];
    if (entry !== undefined && isKiloConcordEntry(entry) && entry.enabled !== false) {
      found = true;
    }
  }
  // A config Kilo cannot read is reported even when another file still has a
  // working entry: the broken file is a problem the user has to fix.
  if (unreadable) return 'unreadable';
  return found;
}

/**
 * Remove Concord's `mcp.concord` entry from every global Kilo config that has
 * one Concord owns. User servers — including a `concord` entry somebody else
 * wrote — and every unrelated key are preserved. Rewriting a `kilo.jsonc`
 * normalizes it to plain JSON, which drops comments; the file stays valid
 * Kilo config either way.
 */
export function uninstallKiloMcpConfig(env: NodeJS.ProcessEnv): void {
  for (const path of kiloGlobalConfigPaths(env)) {
    let existing: string;
    try {
      if (!existsSync(path)) continue;
      existing = readFileSync(path, 'utf8');
      if (ownedEntry(existing) === undefined) continue;
    } catch {
      // An unreadable or malformed file is left untouched; the remaining
      // config files are still checked.
      continue;
    }
    const config = parseKiloConfig(existing);
    const servers = Object.fromEntries(
      Object.entries(config.mcp ?? {}).filter(([name]) => name !== CONCORD_SERVER_KEY),
    );
    const next = `${JSON.stringify({ ...config, mcp: servers }, null, 2)}\n`;
    if (next !== existing) writeFileSync(path, next);
  }
}
