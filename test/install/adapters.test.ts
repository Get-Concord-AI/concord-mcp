import { installGooseMcpConfig } from '../../src/install/goose-config.js';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installGlobalAdapters, statusGlobalAdapters } from '../../src/install/adapters/index.js';

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
      const path = join(bin, executable ?? 'missing');
      writeFileSync(path, `#!/bin/sh\necho ${version ?? '0.0.0'}\n`);
      chmodSync(path, 0o755);
    }
    const env = { HOME: home, PATH: bin };

    const report = installGlobalAdapters(import.meta.url, env);

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
    const cursor = join(bin, 'cursor');
    writeFileSync(cursor, '#!/bin/sh\necho 3.13.10\n');
    chmodSync(cursor, 0o755);
    const configPath = join(home, '.cursor', 'hooks.json');
    mkdirSync(join(home, '.cursor'));
    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: 1,
        hooks: { stop: [{ command: 'node /tmp/user-stop.mjs', timeout: 3 }] },
      })}\n`,
    );

    installGlobalAdapters(import.meta.url, { HOME: home, PATH: bin });
    installGlobalAdapters(import.meta.url, { HOME: home, PATH: bin });

    const installedConfig = readFileSync(configPath, 'utf8');
    expect(installedConfig).toContain('node /tmp/user-stop.mjs');
    expect(installedConfig.split('cursor-hook.mjs\\" stop')).toHaveLength(2);
  });

  it('turns a drained Cursor message into a stop follow-up', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-cursor-receiver-'));
    mkdirSync(join(root, '.concord'));
    writeFileSync(join(root, '.concord', 'concord.db'), '');
    const fakeConcord = join(root, 'fake-concord');
    writeFileSync(
      fakeConcord,
      '#!/bin/sh\nif [ "$2" = "drain" ]; then printf \'[{"messageId":"msg-1","senderAgentId":"gemini:peer","taskId":"TASK-1","content":"hello cursor"}]\'; fi\n',
    );
    chmodSync(fakeConcord, 0o755);

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
    ]);
  });

  it('requires Gemini completion injection in the current project', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-gemini-home-'));
    const project = mkdtempSync(join(tmpdir(), 'concord-gemini-project-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const gemini = join(bin, 'gemini');
    writeFileSync(gemini, '#!/bin/sh\necho 0.55.1\n');
    chmodSync(gemini, 0o755);
    const env = { HOME: home, PATH: bin };
    installGlobalAdapters(import.meta.url, env);

    expect(
      statusGlobalAdapters(env, project).find((entry) => entry.harness === 'gemini'),
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
      statusGlobalAdapters(env, project).find((entry) => entry.harness === 'gemini'),
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
      statusGlobalAdapters(env, project).find((entry) => entry.harness === 'gemini'),
    ).toMatchObject({
      status: 'installed',
      capabilities: ['pull', 'steer', 'idle', 'busy', 'monitor-command'],
    });
  });

  it('fails closed below the verified Cursor monitor baseline', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cursor-old-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const cursor = join(bin, 'cursor');
    writeFileSync(cursor, '#!/bin/sh\necho 2.9.0\n');
    chmodSync(cursor, 0o755);

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
      const path = join(bin, executable ?? 'missing');
      writeFileSync(path, `#!/bin/sh\necho ${version ?? '0.0.0'}\n`);
      chmodSync(path, 0o755);
    }
    const occupied = join(home, '.cursor', 'extensions', 'get-concord-ai.concord-relay');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'package.json'), '{"name":"someone-else"}');

    const report = installGlobalAdapters(import.meta.url, { HOME: home, PATH: bin });

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

    const goose = join(bin, 'goose');
    writeFileSync(goose, '#!/bin/sh\necho 1.51.0\n');
    chmodSync(goose, 0o755);

    const env = { HOME: home, PATH: bin };

    const report = installGlobalAdapters(import.meta.url, env);

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
});
