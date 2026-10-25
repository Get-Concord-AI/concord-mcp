import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { claudeSkillsPluginPath } from '../../src/install/claude-plugin.js';
import {
  adapterNeedsAttention,
  renderAdapterReport,
  statusGlobalAdapters,
} from '../../src/install/adapters/index.js';
import {
  inspectLink,
  installLink,
  isEphemeralPath,
  linkNeedsRepair,
  packagedPath,
  repairAdapterLinks,
} from '../../src/install/adapters/links.js';
import { writeFakeVersion } from '../helpers/fake-command.js';

/** A stand-in package layout: <root>/plugin/concord-relay + a caller module. */
function packagedTree(): { root: string; moduleUrl: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'concord-pkg-'));
  const source = join(root, 'plugin', 'concord-relay');
  mkdirSync(join(source, '.claude-plugin'), { recursive: true });
  writeFileSync(join(source, '.claude-plugin', 'plugin.json'), '{"name":"concord-relay"}');
  return {
    root,
    moduleUrl: pathToFileURL(join(root, 'dist', 'cli', 'commands', 'doctor.js')).href,
    source,
  };
}

const LASTING = (): boolean => false;

describe('adapter links', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let target: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    // An empty PATH: no harness is detected, so only the links decide health.
    env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: join(home, 'bin') };
    target = claudeSkillsPluginPath(env);
  });

  it('links a source, is a no-op when repeated, and re-points a dangling link', () => {
    const { source } = packagedTree();
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(home, 'gone'), target);

    expect(installLink(source, target, LASTING)).toBe('installed');
    expect(installLink(source, target, LASTING)).toBe('installed');
    expect(readlinkSync(target)).toBe(source);
  });

  it('leaves a real directory someone put there alone', () => {
    const { source } = packagedTree();
    mkdirSync(join(target, '.claude-plugin'), { recursive: true });
    writeFileSync(join(target, '.claude-plugin', 'plugin.json'), '{"name":"mine"}');

    expect(installLink(source, target, LASTING)).toBe('occupied');
    expect(readFileSync(join(target, '.claude-plugin', 'plugin.json'), 'utf8')).toContain('mine');
  });

  it('keeps a working link rather than moving it into a throwaway checkout', () => {
    const lasting = packagedTree();
    const scratch = packagedTree();
    const isScratch = (path: string): boolean => path.startsWith(scratch.root);
    installLink(lasting.source, target, isScratch);

    installLink(scratch.source, target, isScratch);
    expect(readlinkSync(target)).toBe(lasting.source);

    rmSync(lasting.root, { recursive: true });
    installLink(scratch.source, target, isScratch);
    expect(readlinkSync(target)).toBe(scratch.source);
  });

  it('finds a packaged directory from any caller depth', () => {
    const { root, source } = packagedTree();
    for (const rel of ['dist/cli/setup.js', 'dist/cli/commands/setup.js', 'src/x/y/z/a.ts']) {
      const url = pathToFileURL(join(root, rel)).href;
      expect(packagedPath(url, ['plugin', 'concord-relay'])).toBe(source);
    }
  });

  it('reports nothing when the package has no such directory', () => {
    const bare = mkdtempSync(join(tmpdir(), 'concord-bare-'));
    const url = pathToFileURL(join(bare, 'dist', 'cli', 'setup.js')).href;
    expect(packagedPath(url, ['plugin', 'concord-relay'])).toBeUndefined();
  });

  it('treats temp directories and the npx cache as throwaway', () => {
    expect(isEphemeralPath(join(tmpdir(), 'checkout', 'plugin'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(isEphemeralPath('/private/tmp/claude-501/scratchpad/pr200/plugin')).toBe(true);
    }
    const home = join(sep, 'home', 'a');
    expect(isEphemeralPath(join(home, '.npm', '_npx', 'abc', 'node_modules', 'x', 'plugin'))).toBe(
      true,
    );
    expect(
      isEphemeralPath(join(home, '.nvm', 'versions', 'node', 'v24', 'lib', 'node_modules', 'x')),
    ).toBe(false);
  });

  it('reports a dangling link with where it points and where it should', () => {
    const { moduleUrl, source } = packagedTree();
    const gone = join(home, 'scratchpad', 'plugin', 'concord-relay');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(gone, target);

    expect(inspectLink(target, source)).toMatchObject({ health: 'dangling', pointsTo: gone });
    const claude = statusGlobalAdapters(env, undefined, moduleUrl)[0];
    expect(claude?.status).toBe('action_required');
    expect(claude?.capabilities).toEqual([]);
    expect(claude?.detail).toContain('concord doctor --fix');
    expect(claude !== undefined && adapterNeedsAttention(claude)).toBe(true);
    const rendered = renderAdapterReport(claude === undefined ? [] : [claude]);
    expect(rendered).toContain(`link:     ${target} -> ${gone}`);
    expect(rendered).toContain(`expected: ${source}`);
  });

  it('accepts a link to another lasting copy but flags one into a temp checkout', () => {
    const { moduleUrl, source } = packagedTree();
    const other = packagedTree();
    installLink(other.source, target, LASTING);

    const check = inspectLink(target, source);
    expect(check.health).toBe('foreign');
    expect(linkNeedsRepair(check, LASTING)).toBe(false);
    // Both copies sit in the OS temp directory, so this one will be cleaned up.
    const claude = statusGlobalAdapters(env, undefined, moduleUrl)[0];
    expect(claude?.status).toBe('action_required');
    expect(claude?.detail).toContain('temporary checkout');
    expect(claude?.link?.pointsTo).toBe(other.source);
  });

  it('flags a link into a temp checkout even when doctor runs from that copy', () => {
    const { moduleUrl, source } = packagedTree();
    installLink(source, target, LASTING);

    const check = inspectLink(target, source);
    expect(check.health).toBe('linked');
    expect(linkNeedsRepair(check)).toBe(true);
    expect(statusGlobalAdapters(env, undefined, moduleUrl)[0]?.status).toBe('action_required');
  });

  it('reports a broken link even when the Claude version is unsupported', () => {
    const { moduleUrl } = packagedTree();
    mkdirSync(join(home, 'bin'));
    writeFakeVersion(join(home, 'bin'), 'claude', '1.0.0');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(home, 'gone'), target);

    const claude = statusGlobalAdapters(env, undefined, moduleUrl, LASTING)[0];
    expect(claude?.status).toBe('action_required');
    expect(claude?.link?.health).toBe('dangling');
  });

  it('repairs broken links and leaves healthy ones alone', () => {
    const { moduleUrl, source } = packagedTree();
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(home, 'gone'), target);
    const gemini = join(home, '.gemini', 'extensions', 'concord-relay');

    const repairs = repairAdapterLinks(moduleUrl, env, LASTING);

    expect(repairs).toEqual([
      { harness: 'claude-code', target, from: join(home, 'gone'), to: source },
    ]);
    expect(readlinkSync(target)).toBe(source);
    expect(existsSync(gemini)).toBe(false);
    expect(repairAdapterLinks(moduleUrl, env, LASTING)).toEqual([]);
  });
});
