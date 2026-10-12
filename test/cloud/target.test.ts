import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { writeCredentials, writeLink, writeLocalChoice } from '../../src/cloud/settings.js';
import { cloudTargetFor } from '../../src/cloud/target.js';

const API = 'https://api.concord.test';
const ORIGIN = () => 'git@github.com:Acme/App.git';
const NO_ORIGIN = () => undefined;

describe('cloudTargetFor', () => {
  let home: string;
  let repo: string;
  let folder: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    repo = mkdtempSync(join(tmpdir(), 'concord-repo-'));
    mkdirSync(join(repo, '.git'));
    folder = mkdtempSync(join(tmpdir(), 'concord-folder-'));
  });

  const signIn = () => {
    writeCredentials({ HOME: home }, { apiUrl: API, apiKey: 'ck_test' });
  };

  it('is local while signed out, unless the repository is linked', () => {
    expect(cloudTargetFor(repo, { HOME: home }, ORIGIN)).toBeUndefined();
    writeLink(repo, { apiUrl: API, projectKey: 'github.com/acme/linked' });
    expect(cloudTargetFor(repo, { HOME: home }, ORIGIN)).toEqual({
      apiUrl: API,
      projectKey: 'github.com/acme/linked',
      source: 'link',
    });
  });

  it('signed in, makes a repository its remote’s project by default', () => {
    signIn();
    expect(cloudTargetFor(repo, { HOME: home }, ORIGIN)).toEqual({
      apiUrl: API,
      projectKey: 'github.com/acme/app',
      source: 'default',
    });
  });

  it('keeps a repository local when it chose to, or has no remote to name it by', () => {
    signIn();
    expect(cloudTargetFor(repo, { HOME: home }, NO_ORIGIN)).toBeUndefined();
    writeLocalChoice(repo);
    expect(cloudTargetFor(repo, { HOME: home }, ORIGIN)).toBeUndefined();
  });

  it('puts a named folder outside any repository in general, and presumes nothing of an unnamed one', () => {
    signIn();
    expect(cloudTargetFor(folder, { HOME: home, CLAUDE_PROJECT_DIR: folder }, ORIGIN)).toEqual({
      apiUrl: API,
      projectKey: 'general',
      source: 'default',
    });
    // Started elsewhere, a server may learn its repository from MCP roots.
    expect(cloudTargetFor(folder, { HOME: home }, ORIGIN)).toBeUndefined();
  });

  it('ignores a damaged link file rather than failing', () => {
    signIn();
    mkdirSync(join(repo, '.concord'), { recursive: true });
    writeFileSync(join(repo, '.concord', 'cloud.json'), '{not json');
    expect(cloudTargetFor(repo, { HOME: home }, ORIGIN)?.source).toBe('default');
  });
});
