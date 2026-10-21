import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  COPILOT_HOOKS,
  CopilotConfigParseError,
  copilotConfigFile,
  copilotConfigInstalled,
  copilotHooksFile,
  copilotHooksInstalled,
  installCopilotHooks,
  installCopilotMcpConfig,
  uninstallCopilotConfig,
} from '../../src/install/copilot-config.js';
import { CONCORD_SERVER_COMMAND, CONCORD_SERVER_KEY } from '../../src/install/mcp-config.js';

/** Parse a written config file into a typed shape; no `any` escapes the parse. */
const copilotConfigSchema = z
  .object({
    mcpServers: z.record(
      z.string(),
      z
        .object({
          type: z.string().optional(),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          tools: z.array(z.string()).optional(),
        })
        .loose(),
    ),
  })
  .loose();

function readConfig(path: string): z.infer<typeof copilotConfigSchema> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return copilotConfigSchema.parse(raw);
}

function scratchEnv(): { COPILOT_HOME: string } {
  return { COPILOT_HOME: mkdtempSync(join(tmpdir(), 'concord-copilot-')) };
}

describe('Copilot config paths', () => {
  it('honors COPILOT_HOME for the MCP config and the hooks file', () => {
    const home = join(tmpdir(), 'copilot-home');
    expect(copilotConfigFile({ COPILOT_HOME: home })).toBe(join(home, 'mcp-config.json'));
    expect(copilotHooksFile({ COPILOT_HOME: home })).toBe(join(home, 'hooks', 'concord.json'));
  });

  it('falls back to ~/.copilot when COPILOT_HOME is unset or blank', () => {
    const home = join(tmpdir(), 'user-home');
    expect(copilotConfigFile({ HOME: home, COPILOT_HOME: '  ' })).toBe(
      join(home, '.copilot', 'mcp-config.json'),
    );
    expect(copilotConfigFile({})).toBe(join(homedir(), '.copilot', 'mcp-config.json'));
  });
});

describe('installCopilotMcpConfig', () => {
  it('pins the harness kind but no repository, so every project finds its own', () => {
    const env = scratchEnv();
    const entry = readConfig(installCopilotMcpConfig(env)).mcpServers[CONCORD_SERVER_KEY];
    expect(entry).toEqual({
      type: 'local',
      command: CONCORD_SERVER_COMMAND,
      args: [],
      env: { CONCORD_AGENT_KIND: 'copilot-cli' },
      tools: ['*'],
    });
  });

  it('is idempotent', () => {
    const env = scratchEnv();
    const path = installCopilotMcpConfig(env);
    const first = readFileSync(path, 'utf8');
    installCopilotMcpConfig(env);
    expect(readFileSync(path, 'utf8')).toBe(first);
  });

  it('keeps other servers, top-level keys, and env the user added, dropping an old repo pin', () => {
    const env = scratchEnv();
    writeFileSync(
      copilotConfigFile(env),
      JSON.stringify({
        telemetry: false,
        mcpServers: {
          other: { type: 'http', url: 'https://example.test/mcp' },
          concord: {
            command: CONCORD_SERVER_COMMAND,
            env: { CONCORD_AGENT_ID: 'alpha', CONCORD_REPO_ROOT: '/old/repo' },
          },
        },
      }),
    );
    const config = readConfig(installCopilotMcpConfig(env));
    expect(config['telemetry']).toBe(false);
    expect(config.mcpServers['other']).toEqual({ type: 'http', url: 'https://example.test/mcp' });
    expect(config.mcpServers[CONCORD_SERVER_KEY]?.env).toEqual({
      CONCORD_AGENT_ID: 'alpha',
      CONCORD_AGENT_KIND: 'copilot-cli',
    });
  });

  it('leaves malformed config untouched', () => {
    const env = scratchEnv();
    writeFileSync(copilotConfigFile(env), '{ not json');
    expect(() => installCopilotMcpConfig(env)).toThrow(CopilotConfigParseError);
    expect(readFileSync(copilotConfigFile(env), 'utf8')).toBe('{ not json');
  });

  it.skipIf(process.platform === 'win32')('writes owner-only files', () => {
    const env = scratchEnv();
    expect(statSync(installCopilotMcpConfig(env)).mode & 0o777).toBe(0o600);
    expect(statSync(installCopilotHooks(env)).mode & 0o777).toBe(0o600);
  });
});

describe('Copilot hooks file', () => {
  it('runs the session-start, post-tool-use, and stop hooks for copilot-cli', () => {
    const env = scratchEnv();
    const raw: unknown = JSON.parse(readFileSync(installCopilotHooks(env), 'utf8'));
    expect(raw).toEqual(COPILOT_HOOKS);
    expect(COPILOT_HOOKS.hooks.sessionStart[0].bash).toBe(
      'concord hook session-start --client copilot-cli',
    );
    expect(COPILOT_HOOKS.hooks.postToolUse[0].bash).toContain('post-tool-use --client copilot-cli');
    expect(COPILOT_HOOKS.hooks.agentStop[0].bash).toContain('hook stop --client copilot-cli');
    expect(copilotHooksInstalled(env)).toBe(true);
  });

  it('is not installed when a Concord hook was removed by hand', () => {
    const env = scratchEnv();
    installCopilotHooks(env);
    const { sessionStart, postToolUse } = COPILOT_HOOKS.hooks;
    writeFileSync(
      copilotHooksFile(env),
      JSON.stringify({ version: 1, hooks: { sessionStart, postToolUse } }),
    );
    expect(copilotHooksInstalled(env)).toBe(false);
  });
});

describe('uninstallCopilotConfig', () => {
  it('removes the server entry and hooks file, keeping everything else', () => {
    const env = scratchEnv();
    writeFileSync(
      copilotConfigFile(env),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
    );
    installCopilotMcpConfig(env);
    installCopilotHooks(env);
    expect(copilotConfigInstalled(env)).toBe(true);

    uninstallCopilotConfig(env);
    expect(copilotConfigInstalled(env)).toBe(false);
    expect(existsSync(copilotHooksFile(env))).toBe(false);
    expect(readConfig(copilotConfigFile(env)).mcpServers).toEqual({ other: { command: 'other' } });
  });

  it('leaves a malformed MCP config untouched and is a no-op without one', () => {
    const env = scratchEnv();
    expect(() => {
      uninstallCopilotConfig(env);
    }).not.toThrow();
    writeFileSync(copilotConfigFile(env), '{ not json');
    uninstallCopilotConfig(env);
    expect(readFileSync(copilotConfigFile(env), 'utf8')).toBe('{ not json');
  });
});
