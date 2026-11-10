import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import {
  deepseekConfigPath,
  deepseekHome,
  hasDeepseekConfig,
  installDeepseekConfig,
  removeDeepseekConfig,
  uninstallDeepseekConfig,
  upsertDeepseekConfig,
} from '../../src/install/deepseek-config.js';
import { statusDeepseek } from '../../src/install/adapters/deepseek.js';
import { runSetup } from '../../src/cli/commands/setup.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'concord-deepseek-'));
  homes.push(home);
  const env = { HOME: home };
  return { env, path: deepseekConfigPath(env) };
}

describe('DeepSeek native MCP configuration', () => {
  it('resolves the DSH home override without using another harness home', () => {
    const { env } = fixture();
    expect(deepseekConfigPath(env)).toBe(join(env.HOME, '.dsh', 'cordis.patch.yml'));
    expect(deepseekHome({ ...env, DSH_HOME: '  ' })).toBe(join(env.HOME, '.dsh'));
    expect(deepseekHome({ ...env, DSH_HOME: '~/custom-dsh' })).toBe(join(env.HOME, 'custom-dsh'));
    expect(deepseekHome({ ...env, DSH_HOME: env.HOME })).toBe(env.HOME);
  });

  it.each(['', '[]\n', '# Preferences\n[]\n', '[{ id: persona, config: { prefix: mine } }]\n'])(
    'installs into an empty or flow-style patch list and reruns without changes: %s',
    (existing) => {
      const installed = upsertDeepseekConfig(existing);
      expect(hasDeepseekConfig(installed)).toBe(true);
      expect(upsertDeepseekConfig(installed)).toBe(installed);
      expect(installed).toContain('CONCORD_AGENT_KIND: deepseek');
      expect(installed).toContain('!!js process.cwd()');
      expect(installed).not.toContain('CONCORD_AGENT_ID:');
    },
  );

  it('preserves comments, other servers and unevaluated JavaScript expressions', () => {
    const existing = `# User preferences\n- id: persona\n  config:\n    prefix: !!js process.env.MY_PRIVATE_SETTING # keep this\n- insert:\n    - id: other-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: other\n        transport: stdio\n        command: other-server\n`;
    const installed = upsertDeepseekConfig(existing);
    expect(installed).toContain('# User preferences');
    expect(installed).toContain('!!js process.env.MY_PRIVATE_SETTING # keep this');
    expect(installed).toContain('command: other-server');
    const removed = removeDeepseekConfig(installed);
    expect(removed).toBe(existing);
    expect(removeDeepseekConfig(removed)).toBe(removed);
  });

  it.each([
    'not: a-list\n',
    '- insert: [invalid\n',
    '- id: a\n---\n- id: b\n',
    '- id: a\n  config: !unsupported value\n',
  ])('leaves invalid or unsupported configuration untouched: %s', (existing) => {
    const { env, path } = fixture();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, existing);
    expect(() => {
      installDeepseekConfig(env);
    }).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(existing);
    expect(hasDeepseekConfig(existing)).toBe(false);
  });

  it('does not replace a user entry with the same id or server namespace', () => {
    const custom = `- insert:\n    - id: concord-mcp\n      name: custom-plugin\n      config: { key: mine }\n`;
    expect(() => upsertDeepseekConfig(custom)).toThrow('left untouched');
    expect(removeDeepseekConfig(custom)).toBe(custom);
    const duplicate = `- insert:\n    - id: my-concord\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: { serverName: concord, transport: stdio, command: wrapper }\n`;
    expect(() => upsertDeepseekConfig(duplicate)).toThrow('left untouched');
  });

  it('keeps edits inside the managed row on setup reruns', () => {
    const custom = upsertDeepseekConfig().replace(
      'command: concord-mcp',
      'command: /custom/wrapper',
    );
    expect(upsertDeepseekConfig(custom)).toBe(custom);
    expect(hasDeepseekConfig(custom)).toBe(false);
  });

  it('installs and uninstalls only its native row', () => {
    const { env, path } = fixture();
    uninstallDeepseekConfig(env);
    expect(existsSync(path)).toBe(false);
    installDeepseekConfig(env);
    const first = readFileSync(path, 'utf8');
    installDeepseekConfig(env);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(statusDeepseek('/bin/dsh', env)).toMatchObject({
      harness: 'deepseek',
      status: 'installed',
      capabilities: ['pull', 'busy'],
      installedPath: path,
    });
    uninstallDeepseekConfig(env);
    expect(hasDeepseekConfig(readFileSync(path, 'utf8'))).toBe(false);
    expect(statusDeepseek('/bin/dsh', env).status).toBe('action_required');
  });

  it('does not read the config when DSH is absent and reports unreadable config when detected', () => {
    const { env, path } = fixture();
    mkdirSync(path, { recursive: true });
    expect(statusDeepseek(undefined, env).status).toBe('not_detected');
    expect(statusDeepseek('/bin/dsh', env)).toMatchObject({ status: 'action_required' });
    expect(statusDeepseek('/bin/dsh', env).detail).toContain('could not be read');
  });

  it('does not advertise a disabled native plugin as installed', () => {
    const config = upsertDeepseekConfig();
    const document = parseDocument(config, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    });
    document.setIn([0, 'insert', 0, 'disabled'], true);
    expect(hasDeepseekConfig(document.toString())).toBe(false);
    document.setIn([0, 'insert', 0, 'disabled'], false);
    expect(hasDeepseekConfig(document.toString())).toBe(true);
    expect(hasDeepseekConfig(`${document.toString()}- id: concord-mcp\n  disabled: true\n`)).toBe(
      false,
    );
  });

  it('refuses a later override or a managed server namespace collision', () => {
    expect(() =>
      upsertDeepseekConfig(`${upsertDeepseekConfig()}- id: concord-mcp\n  disabled: true\n`),
    ).toThrow('already patches');
    expect(() =>
      upsertDeepseekConfig(
        '- id: mcp-manager\n  config:\n    servers:\n      concord: { transport: stdio, command: my-wrapper }\n',
      ),
    ).toThrow('left untouched');
    expect(() => upsertDeepseekConfig('[1, 2]')).toThrow('mappings');
  });

  it('detects DSH during setup, installs project instructions and preserves a rerun', () => {
    const { env, path } = fixture();
    const root = join(env.HOME, 'repo');
    const bin = join(env.HOME, 'bin');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), '');
    const options = { env: { ...env, PATH: bin }, adapters: true };
    const first = runSetup(root, options);
    expect(first.adapters.find((adapter) => adapter.harness === 'deepseek')?.status).toBe(
      'installed',
    );
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('start_work');
    const config = readFileSync(path, 'utf8');
    runSetup(root, options);
    expect(readFileSync(path, 'utf8')).toBe(config);
  });
});
