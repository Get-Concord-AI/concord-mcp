import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

/**
 * What `concord setup` left behind for each harness, read back the way the
 * harness itself reads it. Drivers take every command from here — never from
 * a hardcoded string — so a drift between installer and handler fails a test.
 */

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Hook commands by harness event name, in the order the harness runs them. */
export type HookTable = Map<string, string[]>;

const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const mcpFileSchema = z.object({ mcpServers: z.record(z.string(), mcpServerSchema) });

function readJson(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The Concord server from a `{ "mcpServers": … }` file (Claude, Cursor, Antigravity). */
export function mcpServerFromJson(path: string): McpServerSpec {
  const parsed = mcpFileSchema.parse(JSON.parse(readJson(path)));
  const server = parsed.mcpServers['concord'];
  if (server === undefined) throw new Error(`${path} registers no concord MCP server.`);
  return { command: server.command, args: server.args ?? [], env: server.env ?? {} };
}

const commandHookSchema = z.object({ type: z.string().optional(), command: z.string() }).loose();
const pluginHooksSchema = z.object({
  hooks: z.record(z.string(), z.array(z.object({ hooks: z.array(commandHookSchema) }).loose())),
});

/** A Claude Code plugin's `hooks/hooks.json`. */
function pluginHooks(pluginRoot: string): HookTable {
  const parsed = pluginHooksSchema.parse(
    JSON.parse(readJson(join(pluginRoot, 'hooks', 'hooks.json'))),
  );
  return new Map(
    Object.entries(parsed.hooks).map(([event, groups]) => [
      event,
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    ]),
  );
}

/** Claude Code plugin hooks, read through the link `setup` placed in HOME. */
export function claudePluginRoot(home: string): string {
  return realpathSync(join(home, '.claude', 'skills', 'concord-relay'));
}

export function claudeHooks(home: string): HookTable {
  return pluginHooks(claudePluginRoot(home));
}

const monitorsSchema = z.array(z.object({ name: z.string(), command: z.string() }).loose());

/** The Claude Code plugin monitor command, with `${CLAUDE_PLUGIN_ROOT}` left for the shell. */
export function claudeMonitorCommand(home: string): string {
  const monitors = monitorsSchema.parse(
    JSON.parse(readJson(join(claudePluginRoot(home), 'monitors', 'monitors.json'))),
  );
  const inbox = monitors.find((monitor) => monitor.name === 'concord-inbox');
  if (inbox === undefined) throw new Error('The Claude plugin declares no concord-inbox monitor.');
  return inbox.command;
}

const cursorHooksSchema = z.object({
  hooks: z.record(z.string(), z.array(commandHookSchema)),
});

/** User-level Cursor hooks (`~/.cursor/hooks.json`). */
export function cursorHooks(home: string): HookTable {
  const parsed = cursorHooksSchema.parse(JSON.parse(readJson(join(home, '.cursor', 'hooks.json'))));
  return new Map(
    Object.entries(parsed.hooks).map(([event, hooks]) => [
      event,
      hooks.map((hook) => hook.command),
    ]),
  );
}

const antigravityHooksSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(commandHookSchema)),
);

/** Workspace Antigravity hooks (`.agents/hooks.json`), merged across their owner groups. */
export function antigravityHooks(repo: string): HookTable {
  const parsed = antigravityHooksSchema.parse(
    JSON.parse(readJson(join(repo, '.agents', 'hooks.json'))),
  );
  const table: HookTable = new Map();
  for (const events of Object.values(parsed)) {
    for (const [event, hooks] of Object.entries(events)) {
      table.set(event, [...(table.get(event) ?? []), ...hooks.map((hook) => hook.command)]);
    }
  }
  return table;
}

/** A TOML basic string, which shares JSON's escapes for everything Concord writes. */
function tomlString(value: string): string {
  return z.string().parse(JSON.parse(value));
}

/**
 * Hook tables and the Concord MCP server from a Codex `config.toml`. Only the shapes Concord writes are understood.
 */
function tomlConfig(path: string): { hooks: HookTable; mcp: McpServerSpec } {
  const lines = readFileSync(path, 'utf8').split('\n');
  const hooks: HookTable = new Map();
  let section = '';
  let mcpCommand: string | undefined;
  const mcpArgs: string[] = [];
  const mcpEnv: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    const header = /^\[\[?([^\]]+)\]\]?$/u.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1];
      continue;
    }
    const entry = /^(\w+)\s*=\s*(.+)$/u.exec(line);
    if (entry?.[1] === undefined || entry[2] === undefined) continue;
    const hookEvent = /^hooks\.(\w+)\.hooks$/u.exec(section)?.[1];
    if (hookEvent !== undefined && entry[1] === 'command') {
      hooks.set(hookEvent, [...(hooks.get(hookEvent) ?? []), tomlString(entry[2])]);
    }
    if (section === 'mcp_servers.concord' && entry[1] === 'command') {
      mcpCommand = tomlString(entry[2]);
    }
    if (section === 'mcp_servers.concord' && entry[1] === 'args') {
      mcpArgs.push(...z.array(z.string()).parse(JSON.parse(entry[2])));
    }
    if (section === 'mcp_servers.concord.env') mcpEnv[entry[1]] = tomlString(entry[2]);
  }
  if (mcpCommand === undefined) throw new Error(`${path} has no concord MCP server.`);
  return { hooks, mcp: { command: mcpCommand, args: mcpArgs, env: mcpEnv } };
}

/** Codex hooks and MCP server from `~/.codex/config.toml`. */
export function codexConfig(home: string): { hooks: HookTable; mcp: McpServerSpec } {
  return tomlConfig(join(home, '.codex', 'config.toml'));
}

/** Commands for one event, failing loudly when the harness would run none. */
export function hookCommands(table: HookTable, event: string): string[] {
  const commands = table.get(event) ?? [];
  if (commands.length === 0) throw new Error(`No ${event} hook is installed.`);
  return commands;
}
