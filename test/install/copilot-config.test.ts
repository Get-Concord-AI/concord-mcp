import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CONCORD_COPILOT_SERVER_KEY,
  CopilotConfigParseError,
  copilotConfigFile,
  copilotConfigInstalled,
  installCopilotMcpConfig,
  uninstallCopilotConfig,
} from '../../src/install/copilot-config.js';
import { CONCORD_SERVER_COMMAND } from '../../src/install/mcp-config.js';

/** Parse a written config file into a typed shape; no `any` escapes the parse. */
const copilotConfigSchema = z
  .object({
    mcpServers: z.record(
      z.string(),
      z.object({
        type: z.string().optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        tools: z.array(z.string()).optional(),
        url: z.string().optional(),
      }),
    ),
  })
  .loose();

const schemaWithSchema = z.object({ $schema: z.string() }).loose();
const telemetrySchema = z.object({ telemetry: z.boolean() }).loose();

function readCopilotConfig(path: string): z.infer<typeof copilotConfigSchema> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return copilotConfigSchema.parse(raw);
}

/** The repo root currently pinned in Concord's Copilot entry. */
function readRoot(path: string): unknown {
  const config = z
    .object({
      mcpServers: z
        .record(z.string(), z.object({ env: z.record(z.string(), z.string()) }))
        .optional(),
    })
    .parse(JSON.parse(readFileSync(path, 'utf8')));
  return config.mcpServers?.['concord']?.env['CONCORD_REPO_ROOT'];
}

describe('copilotConfigFile', () => {
  it('honors COPILOT_HOME', () => {
    const home = join(tmpdir(), 'copilot-home');
    expect(copilotConfigFile({ COPILOT_HOME: home })).toBe(join(home, 'mcp-config.json'));
  });

  it('falls back to APPDATA/copilot on Windows when COPILOT_HOME is unset', () => {
    const appData = join(tmpdir(), 'AppData', 'Roaming');
    expect(copilotConfigFile({ APPDATA: appData })).toBe(
      join(appData, 'copilot', 'mcp-config.json'),
    );
  });

  it('falls back to ~/.copilot when nothing is set or the values are blank', () => {
    const expected = join(homedir(), '.copilot', 'mcp-config.json');
    expect(copilotConfigFile({})).toBe(expected);
    expect(copilotConfigFile({ COPILOT_HOME: '  ' })).toBe(expected);
    expect(copilotConfigFile({ APPDATA: '  ' })).toBe(expected);
  });
});

describe('installCopilotMcpConfig', () => {
  it('writes a local server entry under COPILOT_HOME with the repo root and kind', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    const path = installCopilotMcpConfig({ COPILOT_HOME: home }, '/tmp/repo');

    expect(path).toBe(join(home, 'mcp-config.json'));
    const server = readCopilotConfig(path).mcpServers[CONCORD_COPILOT_SERVER_KEY];
    expect(server?.type).toBe('local');
    expect(server?.command).toBe(CONCORD_SERVER_COMMAND);
    expect(server?.env).toEqual({
      CONCORD_REPO_ROOT: '/tmp/repo',
      CONCORD_AGENT_KIND: 'copilot-cli',
    });
    expect(server?.tools).toEqual(['*']);
  });

  it('is idempotent: re-running produces identical output', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    const env = { COPILOT_HOME: home };
    const first = installCopilotMcpConfig(env, '/tmp/repo');
    const before = readFileSync(first, 'utf8');
    installCopilotMcpConfig(env, '/tmp/repo');
    expect(readFileSync(first, 'utf8')).toBe(before);
  });

  it('preserves other servers and unrelated top-level keys', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    const existing = {
      $schema: 'https://example.test/schema.json',
      mcpServers: { other: { type: 'local', command: 'other-server', args: ['--flag'] } },
    };
    writeFileSync(join(home, 'mcp-config.json'), `${JSON.stringify(existing, null, 2)}\n`);

    const path = installCopilotMcpConfig({ COPILOT_HOME: home }, '/tmp/repo');
    const withSchema = schemaWithSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(withSchema.$schema).toBe('https://example.test/schema.json');
    const config = readCopilotConfig(path);
    expect(config.mcpServers['other']).toEqual({
      type: 'local',
      command: 'other-server',
      args: ['--flag'],
    });
    expect(config.mcpServers[CONCORD_COPILOT_SERVER_KEY]?.command).toBe(CONCORD_SERVER_COMMAND);
  });

  it('preserves a previously pinned repo root when called without one', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    const env = { COPILOT_HOME: home };
    installCopilotMcpConfig(env, '/tmp/original');
    const path = installCopilotMcpConfig(env);
    const server = readCopilotConfig(path).mcpServers[CONCORD_COPILOT_SERVER_KEY];
    expect(server?.env?.['CONCORD_REPO_ROOT']).toBe('/tmp/original');
  });

  it('updates the pinned root when the caller supplies a different one', () => {
    const env = { COPILOT_HOME: mkdtempSync(join(tmpdir(), 'concord-copilot-')) };
    const path = installCopilotMcpConfig(env, '/tmp/old-repo');
    expect(readRoot(path)).toBe('/tmp/old-repo');

    // A caller-supplied root is an explicit instruction: it must win over the
    // pin a previous setup wrote, or moving a repository silently keeps the
    // old one and the server reports the wrong workspace.
    installCopilotMcpConfig(env, '/tmp/new-repo');
    expect(readRoot(path)).toBe('/tmp/new-repo');

    // With no root supplied, the previous pin is kept so a plain re-run does
    // not blank it out.
    installCopilotMcpConfig(env, undefined);
    expect(readRoot(path)).toBe('/tmp/new-repo');
  });

  it('throws when no repo root is available and none was pinned', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    expect(() => installCopilotMcpConfig({ COPILOT_HOME: home })).toThrow(/repository root/u);
  });

  it('leaves malformed config untouched', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    writeFileSync(join(home, 'mcp-config.json'), '{ broken\n');
    expect(() => installCopilotMcpConfig({ COPILOT_HOME: home }, '/tmp/repo')).toThrow(
      CopilotConfigParseError,
    );
    expect(readFileSync(join(home, 'mcp-config.json'), 'utf8')).toBe('{ broken\n');
  });

  it('writes the config with owner-only permissions', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    const path = installCopilotMcpConfig({ COPILOT_HOME: home }, '/tmp/repo');
    // Reset to a known-loose mode, then re-run to prove the chmod is applied.
    chmodSync(path, 0o644);
    installCopilotMcpConfig({ COPILOT_HOME: home }, '/tmp/repo');
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});

describe('copilotConfigInstalled', () => {
  it('is false when no config exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    expect(copilotConfigInstalled({ COPILOT_HOME: home })).toBe(false);
  });

  it('is true once the server is registered and false after uninstall', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    const env = { COPILOT_HOME: home };
    expect(copilotConfigInstalled(env)).toBe(false);
    installCopilotMcpConfig(env, '/tmp/repo');
    expect(copilotConfigInstalled(env)).toBe(true);
    uninstallCopilotConfig(env);
    expect(copilotConfigInstalled(env)).toBe(false);
  });
});

describe('uninstallCopilotConfig', () => {
  it('removes only the Concord server and preserves everything else', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    const env = { COPILOT_HOME: home };
    installCopilotMcpConfig(env, '/tmp/repo');
    const path = copilotConfigFile(env);
    const existing = readCopilotConfig(path);
    const withOther = {
      ...existing,
      telemetry: false,
      mcpServers: {
        ...existing.mcpServers,
        other: { type: 'http', url: 'https://example.test/mcp' },
      },
    };
    writeFileSync(path, `${JSON.stringify(withOther, null, 2)}\n`);

    uninstallCopilotConfig(env);

    const result = readCopilotConfig(path);
    expect(result.mcpServers).not.toHaveProperty(CONCORD_COPILOT_SERVER_KEY);
    expect(result.mcpServers['other']).toEqual({ type: 'http', url: 'https://example.test/mcp' });
    const withTelemetry = telemetrySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(withTelemetry.telemetry).toBe(false);
  });

  it('is a no-op when the config does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-copilot-'));
    expect(() => {
      uninstallCopilotConfig({ COPILOT_HOME: home });
    }).not.toThrow();
  });
});
