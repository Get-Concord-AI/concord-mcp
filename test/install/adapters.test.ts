import { installGooseMcpConfig } from '../../src/install/goose-config.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeFakeCommand, writeFakeVersion } from '../helpers/fake-command.js';

import {
  installGlobalAdapters,
  statusGlobalAdapters,
  uninstallGlobalAdapters,
  versionTuple,
} from '../../src/install/adapters/index.js';

// Links into this checkout count as lasting even when it lives under /tmp.
const LASTING = (): boolean => false;

describe('global harness adapters', () => {
  it('installs every detected file-based adapter independently', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-adapters-home-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    for (const [executable, version] of [
      ['claude', '2.1.223'],
      ['cursor', '3.13.10'],
      ['gemini', '0.55.1'],
    ]) {
      writeFakeVersion(bin, executable ?? 'missing', version ?? '0.0.0');
    }
    const env = { HOME: home, PATH: bin };

    const report = installGlobalAdapters(import.meta.url, env, undefined, LASTING);

    expect(report.find((entry) => entry.harness === 'claude-code')?.status).toBe('installed');
    expect(report.find((entry) => entry.harness === 'gemini')?.status).toBe('installed');
    expect(report.find((entry) => entry.harness === 'cursor')?.status).toBe('installed');
    expect(existsSync(join(home, '.gemini', 'extensions', 'concord-relay'))).toBe(true);
    expect(existsSync(join(home, '.concord', 'adapters.json'))).toBe(true);
    const cursorHooks = readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8');
    expect(cursorHooks).toContain('cursor-hook.mjs\\" session-start');
    expect(cursorHooks).toContain('cursor-hook.mjs\\" stop');
  });

  it('merges Cursor receiver hooks without replacing user hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-hooks-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFakeVersion(bin, 'cursor', '3.13.10');
    const configPath = join(home, '.cursor', 'hooks.json');
    mkdirSync(join(home, '.cursor'));
    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: 1,
        hooks: { stop: [{ command: 'node /tmp/user-stop.mjs', timeout: 3 }] },
      })}\n`,
    );

    installGlobalAdapters(import.meta.url, { HOME: home, PATH: bin }, undefined, LASTING);
    installGlobalAdapters(import.meta.url, { HOME: home, PATH: bin }, undefined, LASTING);

    const installedConfig = readFileSync(configPath, 'utf8');
    expect(installedConfig).toContain('node /tmp/user-stop.mjs');
    expect(installedConfig.split('cursor-hook.mjs\\" stop')).toHaveLength(2);
  });

  it('turns a drained Cursor message into a stop follow-up', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-cursor-receiver-'));
    mkdirSync(join(root, '.concord'));
    writeFileSync(join(root, '.concord', 'concord.db'), '');
    const drained = [
      {
        messageId: 'msg-1',
        senderAgentId: 'gemini:peer',
        taskId: 'TASK-1',
        content: 'hello cursor',
      },
    ];
    const fakeConcord = writeFakeCommand(
      root,
      'fake-concord',
      `if (process.argv[3] === 'drain') process.stdout.write(${JSON.stringify(JSON.stringify(drained))});\n`,
    );

    const hook = join(process.cwd(), 'plugin', 'cursor', 'concord-relay', 'cursor-hook.mjs');
    const result = spawnSync(process.execPath, [hook, 'stop'], {
      cwd: root,
      env: {
        ...process.env,
        CONCORD_EXECUTABLE: fakeConcord,
        CONCORD_CURSOR_DISABLE_HEARTBEAT: '1',
      },
      input: JSON.stringify({ conversation_id: 'cursor-conversation', workspace_roots: [root] }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      followup_message: '[concord from gemini:peer id=msg-1 task=TASK-1]\nhello cursor',
    });
  });

  it('reports monitor/controller quality separately from installation', () => {
    const report = statusGlobalAdapters({ HOME: mkdtempSync(join(tmpdir(), 'concord-empty-')) });

    expect(report.map((entry) => entry.monitor)).toEqual([
      'native-monitor',
      'managed-controller',
      'harness-monitor',
      'harness-monitor',
      'harness-monitor',
      'harness-monitor',
      'harness-monitor',
      'harness-monitor',
      'managed-controller',
    ]);
  });

  it('requires Gemini completion injection in the current project', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-gemini-home-'));
    const project = mkdtempSync(join(tmpdir(), 'concord-gemini-project-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFakeVersion(bin, 'gemini', '0.55.1');
    const env = { HOME: home, PATH: bin };
    installGlobalAdapters(import.meta.url, env, undefined, LASTING);

    expect(
      statusGlobalAdapters(env, project, undefined, LASTING).find(
        (entry) => entry.harness === 'gemini',
      ),
    ).toMatchObject({
      status: 'action_required',
      capabilities: ['pull', 'steer', 'busy'],
    });

    const settingsPath = join(project, '.gemini', 'settings.json');
    mkdirSync(join(project, '.gemini'));
    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        tools: { shell: { backgroundCompletionBehavior: 'inject' } },
      })}\n`,
    );

    expect(
      statusGlobalAdapters(env, project, undefined, LASTING).find(
        (entry) => entry.harness === 'gemini',
      ),
    ).toMatchObject({
      status: 'action_required',
      capabilities: ['pull', 'steer', 'busy'],
    });

    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        tools: { shell: { backgroundCompletionBehavior: 'inject' } },
        experimental: { modelSteering: true },
      })}\n`,
    );

    expect(
      statusGlobalAdapters(env, project, undefined, LASTING).find(
        (entry) => entry.harness === 'gemini',
      ),
    ).toMatchObject({
      status: 'installed',
      capabilities: ['pull', 'steer', 'idle', 'busy', 'monitor-command'],
    });
  });

  it('fails closed below the verified Cursor monitor baseline', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-old-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFakeVersion(bin, 'cursor', '2.9.0');

    const report = statusGlobalAdapters({ HOME: home, PATH: bin });
    expect(report.find((entry) => entry.harness === 'cursor')).toMatchObject({
      status: 'unsupported_version',
      capabilities: [],
    });
  });

  it('reports an occupied harness target without stopping other adapters', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-adapters-occupied-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    for (const [executable, version] of [
      ['cursor', '3.13.10'],
      ['gemini', '0.55.1'],
    ]) {
      writeFakeVersion(bin, executable ?? 'missing', version ?? '0.0.0');
    }
    const occupied = join(home, '.cursor', 'extensions', 'get-concord-ai.concord-relay');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'package.json'), '{"name":"someone-else"}');

    const report = installGlobalAdapters(
      import.meta.url,
      { HOME: home, PATH: bin },
      undefined,
      LASTING,
    );

    expect(report.find((entry) => entry.harness === 'cursor')?.status).toBe('error');
    expect(report.find((entry) => entry.harness === 'gemini')?.status).toBe('installed');
  });
  it('installs Goose config idempotently and preserves other extensions', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-goose-home-'));

    const gooseDir = join(home, '.config', 'goose');
    mkdirSync(gooseDir, { recursive: true });
    const configPath = join(gooseDir, 'config.yaml');

    writeFileSync(
      configPath,
      `extensions:
  developer:
    enabled: true
    type: builtin
    name: developer
`,
    );

    const env = { HOME: home };
    const repoRoot = join(home, 'project');

    installGooseMcpConfig(env);

    const installed = readFileSync(configPath, 'utf8');
    expect(installed).toContain('concord-relay');
    expect(installed).toContain('developer');
    expect(installed).not.toContain('CONCORD_REPO_ROOT');
    expect(installed).not.toContain(repoRoot);

    installGooseMcpConfig(env);

    const secondRun = readFileSync(configPath, 'utf8');
    const occurrences = secondRun.match(/concord-relay/g) ?? [];
    expect(occurrences).toHaveLength(2);
  });

  it('does not install Goose config below the supported version', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-goose-old-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);

    writeFakeVersion(bin, 'goose', '1.51.0');

    const env = { HOME: home, PATH: bin };

    const report = installGlobalAdapters(import.meta.url, env, undefined, LASTING);

    expect(report.find((entry) => entry.harness === 'goose')).toMatchObject({
      status: 'unsupported_version',
      capabilities: [],
    });

    expect(existsSync(join(home, '.config', 'goose', 'config.yaml'))).toBe(false);
  });
  it('does not overwrite a non-mapping extensions value', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-goose-invalid-'));

    const gooseDir = join(home, '.config', 'goose');
    mkdirSync(gooseDir, { recursive: true });
    const configPath = join(gooseDir, 'config.yaml');

    writeFileSync(
      configPath,
      `extensions:
  - existing-extension
`,
    );

    const env = { HOME: home };

    expect(() => {
      installGooseMcpConfig(env);
    }).toThrow('Goose extensions configuration must be a mapping.');

    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('- existing-extension');
  });

  it('detects and installs Antigravity global MCP config when agy is present', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-antigravity-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFakeVersion(bin, 'agy', '1.0.0');

    const env = { HOME: home, PATH: bin };
    const report = installGlobalAdapters(import.meta.url, env, undefined, LASTING);

    expect(report.find((entry) => entry.harness === 'antigravity')).toMatchObject({
      status: 'installed',
      capabilities: ['pull', 'steer', 'idle', 'busy', 'monitor-command'],
    });

    const mcpConfig = readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8');
    expect(mcpConfig).toContain('concord-mcp');
  });

  it('reports action_required when Antigravity is detected via ANTIGRAVITY_AGENT but unconfigured', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-antigravity-env-'));
    const env = { HOME: home, PATH: '', ANTIGRAVITY_AGENT: '1' };

    const report = statusGlobalAdapters(env);
    expect(report.find((entry) => entry.harness === 'antigravity')).toMatchObject({
      detected: true,
      status: 'action_required',
    });
  });

  it('reports not_detected when Antigravity is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-antigravity-absent-'));
    const env = { HOME: home, PATH: '' };

    const report = statusGlobalAdapters(env);
    expect(report.find((entry) => entry.harness === 'antigravity')).toMatchObject({
      detected: false,
      status: 'not_detected',
    });
  });

  it('preserves custom concord server in Antigravity mcp_config.json on install and uninstall', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-antigravity-custom-'));
    const configDir = join(home, '.gemini', 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'mcp_config.json');
    const customConfig = JSON.stringify({
      mcpServers: {
        concord: {
          command: 'my-custom-concord',
          args: ['--custom'],
        },
      },
    });
    writeFileSync(configPath, customConfig);

    const env = { HOME: home, ANTIGRAVITY_AGENT: '1' };
    const installReport = installGlobalAdapters(import.meta.url, env, undefined, LASTING);
    expect(installReport.find((entry) => entry.harness === 'antigravity')?.status).toBe(
      'installed',
    );

    const afterInstall = readFileSync(configPath, 'utf8');
    expect(afterInstall).toContain('my-custom-concord');

    const uninstallReport = uninstallGlobalAdapters(env);
    expect(uninstallReport.find((entry) => entry.harness === 'antigravity')?.status).toBe(
      'installed',
    );

    const afterUninstall = readFileSync(configPath, 'utf8');
    expect(afterUninstall).toContain('my-custom-concord');
  });

  it('reports error when Antigravity config file cannot be read', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-antigravity-err-'));
    const configDir = join(home, '.gemini', 'config');
    mkdirSync(configDir, { recursive: true });
    // Making mcp_config.json a directory causes readFileSync to throw EISDIR
    mkdirSync(join(configDir, 'mcp_config.json'));

    const env = { HOME: home, ANTIGRAVITY_AGENT: '1' };
    const report = statusGlobalAdapters(env);
    expect(report.find((entry) => entry.harness === 'antigravity')?.status).toBe('error');
  });

  it('preserves concord server with custom args and env in Antigravity mcp_config.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-antigravity-args-env-'));
    const configDir = join(home, '.gemini', 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'mcp_config.json');
    const customConfig = JSON.stringify({
      mcpServers: {
        concord: {
          command: 'concord-mcp',
          args: ['--custom-port', '8080'],
          env: {
            CUSTOM_ENV: 'active',
          },
        },
      },
    });
    writeFileSync(configPath, customConfig);

    const env = { HOME: home, ANTIGRAVITY_AGENT: '1' };
    const installReport = installGlobalAdapters(import.meta.url, env, undefined, LASTING);
    expect(installReport.find((entry) => entry.harness === 'antigravity')?.status).toBe(
      'installed',
    );

    const afterInstall = readFileSync(configPath, 'utf8');
    expect(afterInstall).toContain('--custom-port');
    expect(afterInstall).toContain('CUSTOM_ENV');

    const uninstallReport = uninstallGlobalAdapters(env);
    expect(uninstallReport.find((entry) => entry.harness === 'antigravity')?.status).toBe(
      'installed',
    );

    const afterUninstall = readFileSync(configPath, 'utf8');
    expect(afterUninstall).toContain('--custom-port');
    expect(afterUninstall).toContain('CUSTOM_ENV');
  });

  it('finishes global uninstall and removes state even when Antigravity hooks are malformed', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-ag-malformed-uninstall-'));
    const env = { HOME: home, USERPROFILE: home };
    const hooksPath = join(home, '.gemini', 'config', 'hooks.json');
    mkdirSync(dirname(hooksPath), { recursive: true });
    const broken = '{ malformed hooks json';
    writeFileSync(hooksPath, broken);

    const statePath = join(home, '.concord', 'adapters.json');
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{}');

    const report = uninstallGlobalAdapters(env);
    expect(report).toBeDefined();
    expect(existsSync(statePath)).toBe(false);
    expect(readFileSync(hooksPath, 'utf8')).toBe(broken);
  });

  it('reports action_required with remaining hooks detail when hooks remain but MCP is not registered', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-ag-hooks-remaining-'));
    const env = { HOME: home, USERPROFILE: home, ANTIGRAVITY_AGENT: '1' };
    const hooksPath = join(home, '.gemini', 'config', 'hooks.json');
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        concord: {
          SessionStart: [{ command: 'concord hook session-start --client antigravity' }],
          PreInvocation: [{ command: 'concord hook pre-invocation --client antigravity' }],
        },
      }),
    );

    const report = statusGlobalAdapters(env);
    const agEntry = report.find((entry) => entry.harness === 'antigravity');
    expect(agEntry?.status).toBe('action_required');
    expect(agEntry?.detail).toContain('Concord lifecycle hooks remain installed');
  });
});


describe('versionTuple', () => {
  it('parses a v-prefixed version from Hermes output', () => {
    expect(versionTuple('Hermes Agent v0.22.5')).toEqual([0, 22, 5]);
    expect(versionTuple('v1.2.3')).toEqual([1, 2, 3]);
  });

  it('keeps rejecting version numbers embedded in identifiers', () => {
    expect(versionTuple('HermesAgent0.22.5')).toBeUndefined();
  });
});
