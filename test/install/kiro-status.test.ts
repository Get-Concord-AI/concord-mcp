import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { statusKiro } from '../../src/install/adapters/kiro.js';
import {
  installKiroUserConfigs,
  installKiroWorkspaceHooks,
  kiroWorkspaceMcpPath,
} from '../../src/install/kiro-config.js';
import { writeFakeVersion } from '../helpers/fake-command.js';

const SERVER = {
  mcpServers: { concord: { command: 'concord-mcp' } },
};

function repoWithServer(): string {
  const root = mkdtempSync(join(tmpdir(), 'concord-kiro-status-'));
  const path = kiroWorkspaceMcpPath(root);
  mkdirSync(join(root, '.kiro', 'settings'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(SERVER, null, 2)}\n`);
  return root;
}

describe('statusKiro', () => {
  it('reports not_detected when Kiro is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-home-'));
    expect(statusKiro(undefined, undefined, { HOME: home }).status).toBe('not_detected');
  });

  it('reports unreadable MCP settings instead of throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-kiro-unreadable-'));
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-home-'));
    mkdirSync(kiroWorkspaceMcpPath(root), { recursive: true });

    const report = statusKiro(undefined, root, { HOME: home });
    expect(report.status).toBe('action_required');
    expect(report.detail).toContain('could not be read');
  });

  it('asks for lifecycle hooks when only the MCP server is registered', () => {
    const root = repoWithServer();
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-home-'));

    const report = statusKiro(undefined, root, { HOME: home });
    expect(report).toMatchObject({
      detected: true,
      status: 'action_required',
      capabilities: ['pull'],
    });
    expect(report.detail).toContain('durable inbox');
  });

  it('asks for setup when the hooks file is incomplete', () => {
    const root = repoWithServer();
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-home-'));
    mkdirSync(join(root, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(
      join(root, '.kiro', 'hooks', 'concord.json'),
      `${JSON.stringify({
        version: 'v1',
        hooks: [
          {
            name: 'concord-session-start',
            trigger: 'SessionStart',
            action: { type: 'command', command: 'concord hook kiro-session-start' },
          },
        ],
      })}\n`,
    );

    const report = statusKiro(undefined, root, { HOME: home });
    expect(report).toMatchObject({ status: 'action_required', capabilities: ['pull'] });
  });

  it('reports installed with busy-only reachability when hooks are present', () => {
    const root = repoWithServer();
    installKiroWorkspaceHooks(root);
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-home-'));

    const report = statusKiro(undefined, root, { HOME: home });
    expect(report.status).toBe('installed');
    expect(report.capabilities).toEqual(['pull', 'steer', 'busy']);
    expect(report.capabilities).not.toContain('idle');
  });

  it('accepts a user-level registration without workspace files', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-home-'));
    const env = { HOME: home };
    installKiroUserConfigs(env);

    const report = statusKiro(undefined, undefined, env);
    expect(report).toMatchObject({ detected: true, status: 'installed' });
  });

  it('reports unsupported_version for a Kiro CLI older than V3', () => {
    const root = repoWithServer();
    installKiroWorkspaceHooks(root);
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-home-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const cli = writeFakeVersion(bin, 'kiro-cli', 'kiro-cli 2.9.0');

    const report = statusKiro(cli, root, { HOME: home }, cli);
    expect(report).toMatchObject({ status: 'unsupported_version', capabilities: ['pull'] });
    expect(report.detail).toContain('3.0.0');
  });

  it('reports installed for a Kiro CLI V3 or newer', () => {
    const root = repoWithServer();
    installKiroWorkspaceHooks(root);
    const home = mkdtempSync(join(tmpdir(), 'concord-kiro-home-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const cli = writeFakeVersion(bin, 'kiro-cli', 'kiro-cli 3.1.0');

    const report = statusKiro(cli, root, { HOME: home }, cli);
    expect(report.status).toBe('installed');
  });
});
