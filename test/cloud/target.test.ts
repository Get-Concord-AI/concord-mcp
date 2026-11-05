import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ensureMachineKey, writeCredentials } from '../../src/cloud/settings.js';
import { cloudSessionFor } from '../../src/cloud/proxy.js';
import {
  cloudTargetFor,
  linkedMachine,
  MACHINE_PROJECT_HOST,
  machineProjectKey,
} from '../../src/cloud/target.js';
import { writeUserConfig } from '../../src/config/user-config.js';
import { normalizeProjectKey } from '../../src/domain/project-key.js';

const API = 'https://api.concord.test';
const ORIGIN = () => 'git@github.com:Acme/App.git';
const NO_ORIGIN = () => undefined;

describe('cloudTargetFor', () => {
  let home: string;
  let repo: string;
  let folder: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    repo = mkdtempSync(join(tmpdir(), 'concord-repo-'));
    mkdirSync(join(repo, '.git'));
    folder = mkdtempSync(join(tmpdir(), 'concord-folder-'));
    env = { HOME: home };
  });

  const signIn = (withMachine = true) => {
    writeCredentials(env, { apiUrl: API, apiKey: 'ck_test' });
    if (withMachine) ensureMachineKey(env, () => 'machine-1');
  };

  /** Everything a repository could hold that once decided its routing. */
  const strayRepoState = () => {
    mkdirSync(join(repo, '.concord'), { recursive: true });
    writeFileSync(join(repo, '.concord', 'concord.db'), '');
    writeFileSync(join(repo, '.concord', 'cloud.json'), '{ "local": true }\n');
  };

  it('is local on a machine that is not signed in, whatever the repository holds', () => {
    expect(cloudTargetFor(repo, env, ORIGIN)).toBeUndefined();
    strayRepoState();
    writeFileSync(
      join(repo, '.concord', 'cloud.json'),
      JSON.stringify({ apiUrl: API, projectKey: 'github.com/acme/linked' }),
    );
    expect(cloudTargetFor(repo, env, ORIGIN)).toBeUndefined();
  });

  it('on a linked machine, makes a repository its remote’s project', () => {
    signIn();
    expect(cloudTargetFor(repo, env, ORIGIN)).toEqual({
      apiUrl: API,
      projectKey: 'github.com/acme/app',
    });
  });

  it('on a linked machine, ignores local stores and old per-repository choices', () => {
    signIn();
    strayRepoState();
    expect(cloudTargetFor(repo, env, ORIGIN)).toEqual({
      apiUrl: API,
      projectKey: 'github.com/acme/app',
    });
  });

  it('gives a repository with no remote a project of its own on this machine', () => {
    signIn();
    const target = cloudTargetFor(repo, env, NO_ORIGIN);
    expect(target?.projectKey).toBe(machineProjectKey('machine-1', repo));
    expect(target?.projectKey.startsWith(`${MACHINE_PROJECT_HOST}/`)).toBe(true);
  });

  it('puts any folder outside a repository in general', () => {
    signIn();
    expect(cloudTargetFor(folder, env, ORIGIN)).toEqual({ apiUrl: API, projectKey: 'general' });
    expect(cloudTargetFor(folder, { ...env, CLAUDE_PROJECT_DIR: folder }, ORIGIN)).toEqual({
      apiUrl: API,
      projectKey: 'general',
    });
  });

  it('is local after `cloud unlink`, and linked again after `cloud link`', () => {
    signIn();
    writeUserConfig(env, { cloudLink: false });
    expect(cloudTargetFor(repo, env, ORIGIN)).toBeUndefined();
    expect(linkedMachine(env)).toBeUndefined();
    writeUserConfig(env, { cloudLink: true });
    expect(cloudTargetFor(repo, env, ORIGIN)?.projectKey).toBe('github.com/acme/app');
  });

  it('stays local, rather than failing, when this machine has no identity', () => {
    signIn(false);
    expect(cloudTargetFor(repo, env, ORIGIN)).toBeUndefined();
    expect(cloudSessionFor(repo, env, undefined)).toBeUndefined();
  });
});

describe('machineProjectKey', () => {
  it('is a key the cloud accepts unchanged, readable, and unique per machine and folder', () => {
    const repo = '/Users/someone/scratch/My Experiment!';
    const key = machineProjectKey('machine-1', repo);
    expect(normalizeProjectKey(key)).toBe(key);
    expect(key).toMatch(/^local\.concord\/[0-9a-f]{12}\/my-experiment-[0-9a-f]{8}$/u);
    expect(machineProjectKey('machine-2', repo)).not.toBe(key);
    expect(machineProjectKey('machine-1', '/elsewhere/My Experiment!')).not.toBe(key);
    expect(key).not.toContain('machine-1');
    expect(key).not.toContain('someone');
  });

  it('names a folder with nothing readable in it all the same', () => {
    const key = machineProjectKey('machine-1', '/tmp/!!!');
    expect(key).toMatch(/\/repo-[0-9a-f]{8}$/u);
    expect(normalizeProjectKey(key)).toBe(key);
    expect(basename(key)).not.toBe('');
  });
});
