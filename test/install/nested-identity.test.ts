import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  agentIdForSession,
  resolveServerIdentity,
  SESSION_SOURCES,
} from '../../src/domain/identity.js';
import { applyGlobalMode } from '../../src/install/global-mode.js';
import { gooseConfigPath, installGooseMcpConfig } from '../../src/install/goose-config.js';
import { installMcpConfigs } from '../../src/install/mcp-config.js';
import { writeFakeCommand } from '../helpers/fake-command.js';

/**
 * A harness started from another harness's shell inherits that shell's session
 * variable. Whether its Concord MCP server then acts as itself or as its parent
 * depends on what `concord setup` wrote into the harness's MCP config, so these
 * tests read the pin back out of the files the real installers write and then
 * resolve the server's identity from exactly that environment.
 */
const PARENT_SESSION = 'parent-claude-code-session';
const CHILD_SESSION = 'child-harness-session';

const serversSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({ env: z.record(z.string(), z.string()).optional() }).loose(),
  ),
});
const gooseSchema = z.object({
  extensions: z.record(
    z.string(),
    z.object({ envs: z.record(z.string(), z.string()).optional() }).loose(),
  ),
});

/** The `env` Concord's server entry carries in a JSON `mcpServers` file. */
function jsonEnv(path: string): Record<string, string> {
  const parsed = serversSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.mcpServers['concord']?.env ?? {};
}

/** The `[mcp_servers.concord.env]` keys of a Grok TOML file. */
function grokEnv(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf8');
  const table = /\[mcp_servers\.concord\.env\]\n((?:[^[\n][^\n]*\n)*)/u.exec(text)?.[1] ?? '';
  const env: Record<string, string> = {};
  for (const line of table.split('\n')) {
    const entry = /^(\w+) = "([^"]*)"$/u.exec(line.trim());
    if (entry?.[1] !== undefined && entry[2] !== undefined) env[entry[1]] = entry[2];
  }
  return env;
}

function gooseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const parsed = gooseSchema.parse(load(readFileSync(gooseConfigPath(env), 'utf8')));
  return parsed.extensions['concord-relay']?.envs ?? {};
}

/**
 * The environment a server gets when `kind`'s client runs inside Claude Code: the
 * parent's session variable, the client's own (if it exports one), and the
 * entry's env from its MCP config.
 */
function nestedEnv(kind: string, configured: Record<string, string>): NodeJS.ProcessEnv {
  const own = SESSION_SOURCES.find((source) => source.kind === kind);
  return {
    CLAUDE_CODE_SESSION_ID: PARENT_SESSION,
    ...(own === undefined ? {} : { [own.envVar]: CHILD_SESSION }),
    ...configured,
  };
}

function homeWith(harnesses: readonly string[]): NodeJS.ProcessEnv & { HOME: string } {
  const home = mkdtempSync(join(tmpdir(), 'concord-nested-home-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  for (const name of harnesses) writeFakeCommand(bin, name, '');
  return { HOME: home, PATH: bin, CODEX_HOME: join(home, '.codex') };
}

/** Each place a harness's MCP registration is written, with the config it got. */
function registrations(): { label: string; kind: string; env: Record<string, string> }[] {
  const repo = mkdtempSync(join(tmpdir(), 'concord-nested-repo-'));
  installMcpConfigs(repo);

  const machine = homeWith(['cursor', 'gemini', 'grok', 'goose']);
  applyGlobalMode(machine, true);
  installGooseMcpConfig(machine);

  return [
    {
      label: 'project .cursor/mcp.json',
      kind: 'cursor',
      env: jsonEnv(join(repo, '.cursor', 'mcp.json')),
    },
    {
      label: 'user ~/.cursor/mcp.json',
      kind: 'cursor',
      env: jsonEnv(join(machine.HOME, '.cursor', 'mcp.json')),
    },
    {
      label: 'project .gemini/settings.json',
      kind: 'gemini',
      env: jsonEnv(join(repo, '.gemini', 'settings.json')),
    },
    {
      label: 'user ~/.gemini/settings.json',
      kind: 'gemini',
      env: jsonEnv(join(machine.HOME, '.gemini', 'settings.json')),
    },
    {
      label: 'project .grok/config.toml',
      kind: 'grok',
      env: grokEnv(join(repo, '.grok', 'config.toml')),
    },
    {
      label: 'user ~/.grok/config.toml',
      kind: 'grok',
      env: grokEnv(join(machine.HOME, '.grok', 'config.toml')),
    },
    { label: 'goose config.yaml', kind: 'goose', env: gooseEnv(machine) },
  ];
}

describe('a harness started from a Claude Code shell', () => {
  it.each(registrations())('$label pins its own kind', ({ kind, env }) => {
    expect(env['CONCORD_AGENT_KIND']).toBe(kind);
  });

  it.each(registrations().filter(({ kind }) => kind === 'grok' || kind === 'goose'))(
    '$label acts as itself, not as the parent Claude Code agent',
    ({ kind, env }) => {
      const identity = resolveServerIdentity(nestedEnv(kind, env));

      expect(identity).toEqual({
        agentId: agentIdForSession(kind, CHILD_SESSION),
        kind,
        origin: 'session',
      });
    },
  );

  it.each(registrations().filter(({ kind }) => kind === 'cursor' || kind === 'gemini'))(
    '$label never borrows the parent session when it has none of its own',
    ({ kind, env }) => {
      // These clients export no session variable to their MCP servers; they are
      // identified by their hooks. Unidentified is correct. The parent is not.
      expect(resolveServerIdentity(nestedEnv(kind, env))).toBeUndefined();
    },
  );

  it('keeps Claude Code on its own session when Claude Code is the one nested', () => {
    // Claude Code launched from a Grok shell sees both variables and is unpinned.
    const identity = resolveServerIdentity({
      CLAUDE_CODE_SESSION_ID: CHILD_SESSION,
      GROK_SESSION_ID: PARENT_SESSION,
    });

    expect(identity?.kind).toBe('claude-code');
    expect(identity?.agentId).toBe(agentIdForSession('claude-code', CHILD_SESSION));
  });
});

describe('project files shared by more than one client', () => {
  it('leaves .mcp.json unpinned so whichever client reads it resolves its own session', () => {
    const repo = mkdtempSync(join(tmpdir(), 'concord-shared-repo-'));
    installMcpConfigs(repo);

    expect(jsonEnv(join(repo, '.mcp.json'))['CONCORD_AGENT_KIND']).toBeUndefined();
  });
});
