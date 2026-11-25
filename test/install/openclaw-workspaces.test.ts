import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { upsertBlock } from '../../src/install/block.js';
import { applyGlobalMode } from '../../src/install/global-mode.js';
import { writeFakeCommand } from '../helpers/fake-command.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'concord-openclaw-workspaces-'));
  homes.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const roster = (entries: { id: string; workspace: string }[]): void => {
    writeFakeCommand(bin, 'openclaw', `console.log(${JSON.stringify(JSON.stringify(entries))});`);
  };
  return { home, bin, env: { ...process.env, HOME: home, PATH: bin }, roster };
}

describe('OpenClaw global workspace instructions', () => {
  it('writes distinct IDs and removes stale blocks without changing project instructions', () => {
    const { home, env, roster } = fixture();
    const main = join(home, 'main');
    const research = join(home, 'research');
    const projectFile = join(main, 'AGENTS.md');
    const researchFile = join(research, 'AGENTS.md');
    mkdirSync(main);
    const project = upsertBlock('# Project\n', 'Project Concord instructions');
    writeFileSync(projectFile, project);

    roster([
      { id: 'main', workspace: main },
      { id: 'research', workspace: research },
    ]);
    const setup = applyGlobalMode(env, true);
    expect(setup.warnings).toEqual([]);
    expect(readFileSync(projectFile, 'utf8')).toContain('agent_id: "openclaw:main"');
    expect(readFileSync(researchFile, 'utf8')).toContain('agent_id: "openclaw:research"');

    roster([{ id: 'main', workspace: main }]);
    const changed = applyGlobalMode(env, true, { openclawFiles: setup.openclawFiles });
    expect(existsSync(researchFile)).toBe(false);
    expect(changed.openclawFiles).toHaveLength(1);

    const removed = applyGlobalMode(env, false, { openclawFiles: changed.openclawFiles });
    expect(removed.openclawFiles).toEqual([]);
    expect(readFileSync(projectFile, 'utf8')).toBe(project);
  });

  it('recognizes shared workspaces through filesystem aliases', () => {
    const { home, env, roster } = fixture();
    const main = join(home, 'main');
    const alias = join(home, 'alias');
    mkdirSync(main);
    symlinkSync(main, alias, 'junction');
    const file = join(main, 'AGENTS.md');

    roster([{ id: 'main', workspace: main }]);
    const setup = applyGlobalMode(env, true);
    roster([{ id: 'main', workspace: alias }]);
    const moved = applyGlobalMode(env, true, { openclawFiles: setup.openclawFiles });
    expect(readFileSync(file, 'utf8')).toContain('agent_id: "openclaw:main"');

    roster([
      { id: 'main', workspace: main },
      { id: 'research', workspace: alias },
    ]);
    const shared = applyGlobalMode(env, true, { openclawFiles: moved.openclawFiles });
    expect(shared.warnings).toEqual([expect.stringContaining('main, research share a workspace')]);
    expect(shared.openclawFiles).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('groups aliases of a workspace that has not been created yet', () => {
    const { home, env, roster } = fixture();
    const real = join(home, 'real');
    const alias = join(home, 'alias');
    mkdirSync(real);
    symlinkSync(real, alias, 'junction');

    roster([
      { id: 'main', workspace: join(real, 'new', 'workspace') },
      { id: 'research', workspace: join(alias, 'new', 'workspace') },
    ]);
    const report = applyGlobalMode(env, true);
    expect(report.warnings).toEqual([expect.stringContaining('main, research share a workspace')]);
    expect(report.openclawFiles).toEqual([]);
    expect(existsSync(join(real, 'new'))).toBe(false);
  });

  it('retains a path that could not be read so cleanup can retry it', () => {
    const { home, env } = fixture();
    const path = join(home, 'workspace', 'AGENTS.md');
    mkdirSync(path, { recursive: true });
    const report = applyGlobalMode(env, false, { openclawFiles: [path] });
    expect(report.openclawFiles).toHaveLength(1);
    expect(report.warnings).toHaveLength(1);
  });

  it('warns and avoids guessing when the OpenClaw CLI cannot resolve the roster', () => {
    const { home, bin, env, roster } = fixture();
    const main = join(home, 'main');
    roster([{ id: 'main', workspace: main }]);
    const setup = applyGlobalMode(env, true);

    writeFakeCommand(bin, 'openclaw', 'process.exitCode = 1;');
    const report = applyGlobalMode(env, true, { openclawFiles: setup.openclawFiles });
    expect(report.warnings).toEqual([
      expect.stringContaining('Could not read OpenClaw agent workspaces'),
    ]);
    expect(report.openclawFiles).toEqual(setup.openclawFiles);
    expect(readFileSync(join(main, 'AGENTS.md'), 'utf8')).toContain('agent_id: "openclaw:main"');
    expect(existsSync(join(home, '.openclaw', 'workspace', 'AGENTS.md'))).toBe(false);
  });
});
