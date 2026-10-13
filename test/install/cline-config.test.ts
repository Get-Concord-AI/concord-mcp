import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSetup } from '../../src/cli/commands/setup.js';
import { resolveRepoRoot } from '../../src/config/paths.js';
import { installGlobalAdapters, statusGlobalAdapters } from '../../src/install/adapters/index.js';
import {
  ClineConfigParseError,
  clineConfigInstalled,
  clineMcpSettingsPath,
  installClineMcpConfig,
  uninstallClineConfig,
} from '../../src/install/cline-config.js';

function homeWithCline(version: string): { HOME: string; PATH: string; CODEX_HOME: string } {
  const home = mkdtempSync(join(tmpdir(), 'concord-cline-home-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const script = join(bin, 'cline');
  writeFileSync(script, `#!/bin/sh\necho ${version}\n`);
  chmodSync(script, 0o755);
  return { HOME: home, PATH: bin, CODEX_HOME: join(home, 'codex') };
}

function repoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'concord-cline-repo-'));
  mkdirSync(join(dir, '.git'));
  return dir;
}

function writeSettings(env: { HOME: string }, contents: string): string {
  const path = clineMcpSettingsPath(env);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

const rule = (root: string) => readFileSync(join(root, '.cline', 'rules', 'concord.md'), 'utf8');

describe('Cline MCP settings', () => {
  it('merges Concord into the global settings file, reruns safely and uninstalls only Concord', () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), 'concord-cline-settings-')) };
    const repo = repoDir();
    const path = writeSettings(
      env,
      JSON.stringify({
        theme: 'dark',
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] },
          concord: {
            command: 'concord-mcp',
            args: ['--extra'],
            env: { MY_CUSTOM: '1', CONCORD_REPO_ROOT: '/old', CONCORD_AGENT_KIND: 'cline' },
            disabled: true,
            autoApprove: ['start_work'],
          },
        },
      }),
    );

    expect(installClineMcpConfig(repo, env)).toBe(path);
    const first = readFileSync(path, 'utf8');
    installClineMcpConfig(repo, env);

    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(first).toContain('"theme": "dark"');
    expect(first).toContain('"--extra"');
    expect(first).toContain('"MY_CUSTOM": "1"');
    expect(first).toContain('"autoApprove"');
    expect(first).toContain(`"CONCORD_REPO_ROOT": "${repo}"`);
    expect(first).toContain('"CONCORD_AGENT_KIND": "cline"');
    expect(first).toContain('"disabled": false');
    expect(first).not.toContain('/old');
    expect(clineConfigInstalled(env)).toBe(true);
    expect(resolveRepoRoot(env.HOME, { CONCORD_REPO_ROOT: repo })).toBe(realpathSync(repo));

    uninstallClineConfig(env);
    const left = readFileSync(path, 'utf8');
    expect(left).toContain('"filesystem"');
    expect(left).not.toContain('concord-mcp');
    expect(clineConfigInstalled(env)).toBe(false);
  });

  it('leaves a malformed settings file untouched', () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), 'concord-cline-bad-')) };
    const path = writeSettings(env, '{');

    expect(() => installClineMcpConfig(repoDir(), env)).toThrow(ClineConfigParseError);
    expect(readFileSync(path, 'utf8')).toBe('{');
    expect(clineConfigInstalled(env)).toBe(false);
  });
});

describe('Cline adapter setup', () => {
  it('installs on setup when Cline is detected and is byte-identical on rerun', () => {
    const env = homeWithCline('1.2.3');
    const repo = repoDir();
    const path = writeSettings(env, JSON.stringify({ mcpServers: { other: { command: 'echo' } } }));

    const result = runSetup(repo, { env, adapters: true });
    const first = readFileSync(path, 'utf8');
    runSetup(repo, { env, adapters: true });

    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(first).toContain('"other"');
    expect(first).toContain(`"CONCORD_REPO_ROOT": "${result.repoRoot}"`);
    expect(rule(result.repoRoot)).toContain('start_work');
    expect(statusGlobalAdapters(env).find((entry) => entry.harness === 'cline')).toMatchObject({
      detected: true,
      status: 'installed',
      capabilities: ['pull', 'busy'],
    });
  });

  it('leaves the MCP settings alone under --no-mcp but still writes the rule', () => {
    const env = homeWithCline('1.2.3');
    const result = runSetup(repoDir(), { env, mcp: false, adapters: true });

    expect(clineConfigInstalled(env)).toBe(false);
    expect(rule(result.repoRoot)).toContain(
      'concord inbox drain --agent <agent-id> --provider cline',
    );
  });

  it('does not install below the MCP baseline', () => {
    const env = homeWithCline('0.9.0');
    const report = installGlobalAdapters(import.meta.url, env, repoDir());

    expect(report.find((entry) => entry.harness === 'cline')).toMatchObject({
      status: 'unsupported_version',
      capabilities: [],
    });
    expect(clineConfigInstalled(env)).toBe(false);
  });
});
