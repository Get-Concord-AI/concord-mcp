import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';
import { isEscaped, isJsonObject, parseJsoncObject, propertyObject, removeProperty, uncomment } from './jsonc-edit.js';
import { jsonValueSchema, type JsonObject, type JsonValue } from './json-value.js';
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
 * Kilo is an OpenCode fork: it merges several JSONC files — the global
 * `$XDG_CONFIG_HOME/kilo`/`~/.config/kilo` directory (`config.json`,
 * `kilo.json`, `kilo.jsonc`, `opencode.json`, `opencode.jsonc`, lowest to
 * highest precedence) plus every file `KILO_CONFIG_DIR` points at
 * (`kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json`), which
 * outranks the global directory. `kilo mcp add` writes its own file, so
 * registration goes through the harness; status and removal read the same
 * file set and let the highest-precedence `mcp.concord` win, mirroring Kilo's
 * deep merge, because `kilo mcp` has no remove command.
 *
 * The entry pins only the harness kind. Kilo passes no session id to MCP
 * servers — not in request metadata and not in the child environment — so a
 * session resolves its identity the way other session-less harnesses do:
 * `CONCORD_AGENT_ID` in the server's `environment`, or an id the caller
 * supplies. See docs/kilo.md.
 */

const COMMAND_TIMEOUT_MS = 30_000;

/** Environment keys Concord itself writes; anything else makes the entry the user's. */
const CONCORD_ENV_KEYS = new Set(['CONCORD_REPO_ROOT', AGENT_KIND_ENV]);

const kiloServerSchema = z
  .object({
    type: z.string().optional(),
    command: z.array(z.string()).optional(),
    url: z.string().optional(),
    enabled: z.boolean().optional(),
    environment: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .loose();

/**
 * `mcp` stays a loose record of JSON values: a sibling server in a shape
 * Kilo tolerates but this schema does not must not make the whole file
 * unreadable. Only the `concord` entry is validated strictly.
 */
const kiloConfigSchema = z
  .object({
    mcp: z.record(z.string(), jsonValueSchema).optional(),
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
 * Kilo's `KILO_CONFIG_DIR` override — an additional config directory whose
 * files outrank the global directory, including the `~` prefixes Kilo accepts.
 */
export function kiloConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env['KILO_CONFIG_DIR']?.trim();
  if (configured === undefined || configured === '') return undefined;
  if (configured === '~') return userHome(env);
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return resolve(userHome(env), configured.slice(2));
  }
  return resolve(configured);
}

/**
 * Global config files Kilo reads, in its own read-merge order (lowest to
 * highest precedence): `config.json`, `kilo.json`, `kilo.jsonc`,
 * `opencode.json`, `opencode.jsonc`.
 */
const GLOBAL_CONFIG_FILES = [
  'config.json',
  'kilo.json',
  'kilo.jsonc',
  'opencode.json',
  'opencode.jsonc',
] as const;

/** Files a `KILO_CONFIG_DIR` directory contributes, again lowest to highest. */
const CONFIG_DIR_FILES = ['kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json'] as const;

/**
 * Every config file that can carry `mcp.concord`, ordered the way Kilo merges
 * them: the whole global directory first, then the whole `KILO_CONFIG_DIR`
 * directory. The last file defining the entry decides the effective one.
 */
export function kiloConfigPaths(env: NodeJS.ProcessEnv): string[] {
  const paths = GLOBAL_CONFIG_FILES.map((name) => join(kiloConfigHome(env), name));
  const dir = kiloConfigDir(env);
  if (dir !== undefined) {
    for (const name of CONFIG_DIR_FILES) paths.push(join(dir, name));
  }
  return paths;
}

/**
 * JSONC → JSON on top of the shared comment stripper: `uncomment` blanks
 * comments in place (strings and escapes untouched), then commas whose next
 * real token closes an object or array are dropped for trailing commas.
 */
function jsoncToJson(source: string): string {
  const clean = uncomment(source);
  let out = '';
  let inString = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean.charAt(index);
    if (inString) {
      out += char;
      if (char === '"' && !isEscaped(clean, index)) inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (next < clean.length && /\s/u.test(clean.charAt(next))) next += 1;
      const following = clean.charAt(next);
      if (following === '}' || following === ']') continue;
    }
    out += char;
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

/**
 * Whether a `mcp.concord` entry is one Concord wrote and may therefore manage.
 * The shape must be the one `kilo mcp add` produces: `concord-mcp` alone as the
 * command, or a runner invocation carrying the published package spec — a
 * `concord-mcp` argument buried in a user's own wrapper does not count — and
 * only Concord's own environment keys under either `environment` or Kilo's
 * `env` alias.
 */
function isKiloConcordEntry(entry: KiloServer): boolean {
  const command = entry.command ?? [];
  const launchesConcord =
    (command.length === 1 && command[0] === CONCORD_SERVER_COMMAND) ||
    command.some((arg) => isPackageSpec(arg, CONCORD_PACKAGE_NAME));
  if (!launchesConcord) return false;
  const envKeys = [...Object.keys(entry.environment ?? {}), ...Object.keys(entry.env ?? {})];
  return envKeys.every((key) => CONCORD_ENV_KEYS.has(key));
}

/** The `mcp.concord` value of one parsed config when present, whatever its shape. */
function concordValue(config: KiloConfig): JsonValue | undefined {
  return config.mcp?.[CONCORD_SERVER_KEY];
}

/** Strictly parse a `mcp.concord` value into the server shape, if it is one. */
function parseKiloServer(value: JsonValue): KiloServer | undefined {
  if (!isJsonObject(value)) return undefined;
  const parsed = kiloServerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Deep-merge JSON values the way Kilo's config merge does: later keys win. */
function mergeJsonValue(base: JsonValue, overlay: JsonValue): JsonValue {
  if (isJsonObject(base) && isJsonObject(overlay)) {
    const merged: JsonObject = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      const existing = merged[key];
      merged[key] = existing === undefined ? value : mergeJsonValue(existing, value);
    }
    return merged;
  }
  return overlay;
}

export type KiloMcpState = 'none' | 'installed' | 'disabled' | 'conflict' | 'unreadable';

export interface KiloMcpStatus {
  state: KiloMcpState;
  /** Config file that last defined `mcp.concord`, for diagnostics. */
  path?: string;
}

/**
 * The effective `mcp.concord` across every config file Kilo merges, folded in
 * precedence order so the last definition — including a later `enabled:
 * false` — decides, mirroring Kilo's deep merge. 'unreadable' means a config
 * file exists but cannot be parsed: it is reported even when another file has
 * a working entry, since Kilo loads all of them. 'conflict' means the winning
 * entry is not one Concord wrote, so setup must not overwrite it.
 */
export function kiloMcpState(env: NodeJS.ProcessEnv): KiloMcpStatus {
  let effective: JsonValue | undefined;
  let lastPath: string | undefined;
  let unreadable = false;
  for (const path of kiloConfigPaths(env)) {
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
    const entry = concordValue(config);
    if (entry === undefined) continue;
    effective = effective === undefined ? entry : mergeJsonValue(effective, entry);
    lastPath = path;
  }
  if (unreadable) return { state: 'unreadable' };
  if (effective === undefined) return { state: 'none' };
  const server = parseKiloServer(effective);
  if (server === undefined || !isKiloConcordEntry(server)) {
    return lastPath === undefined ? { state: 'conflict' } : { state: 'conflict', path: lastPath };
  }
  if (server.enabled === false) {
    return lastPath === undefined ? { state: 'disabled' } : { state: 'disabled', path: lastPath };
  }
  return { state: 'installed' };
}

/**
 * Register (or refresh) Concord's MCP server through `kilo mcp add`, which
 * writes the global `kilo.jsonc` itself. `kilo mcp add` replaces the whole
 * named entry, so it only runs when no `mcp.concord` exists at all — an owned
 * entry already pins the kind, and a foreign or disabled one belongs to the
 * user. The kind is pinned so a Kilo started from another harness's shell
 * cannot inherit that harness's session source.
 */
export function installKiloMcpConfig(executable: string, env: NodeJS.ProcessEnv): void {
  if (kiloMcpState(env).state !== 'none') return;
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
 * Remove Concord's `mcp.concord` entry from every Kilo config file that has
 * one Concord owns, editing the text in place so comments, formatting and key
 * order survive. User servers — including a `concord` entry somebody else
 * wrote — and every unrelated key are preserved, and a malformed file is left
 * untouched while the remaining files are still checked.
 */
export function uninstallKiloMcpConfig(env: NodeJS.ProcessEnv): void {
  for (const path of kiloConfigPaths(env)) {
    let text: string;
    try {
      if (!existsSync(path)) continue;
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let owned: boolean;
    try {
      const entry = parseKiloServer(concordValue(parseKiloConfig(text)) ?? null);
      owned = entry !== undefined && isKiloConcordEntry(entry);
    } catch {
      continue;
    }
    if (!owned) continue;
    const next = removeConcordEntry(text);
    if (next !== undefined && next !== text) writeFileSync(path, next);
  }
}

/**
 * Splice `"concord": {…}` out of the `"mcp"` object without reformatting the
 * file. Returns undefined when the text layout does not match what the parse
 * saw — duplicate keys or unusual formatting — so the file is left alone
 * rather than rewritten blindly.
 */
function removeConcordEntry(text: string): string | undefined {
  const mcp = propertyObject(text, 'mcp');
  if (mcp === undefined) return undefined;
  const inner = text.slice(mcp.open, mcp.close + 1);
  const concord = propertyObject(inner, CONCORD_SERVER_KEY);
  if (concord === undefined) return undefined;
  // Confirm the located entry is the owned one before touching anything.
  try {
    const located = parseKiloServer(
      parseJsoncObject(inner.slice(concord.open, concord.close + 1)),
    );
    if (located === undefined || !isKiloConcordEntry(located)) return undefined;
  } catch {
    return undefined;
  }
  return removeProperty(text, mcp, {
    key: mcp.open + concord.key,
    close: mcp.open + concord.close,
  });
}
