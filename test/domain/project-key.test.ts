import { describe, expect, it } from 'vitest';

import { normalizeProjectKey } from '../../src/domain/project-key.js';

describe('normalizeProjectKey', () => {
  it.each([
    'git@github.com:Get-Concord-AI/concord-cloud.git',
    'https://github.com/Get-Concord-AI/concord-cloud',
    'https://github.com/get-concord-ai/concord-cloud.git',
    'https://user:token@github.com/Get-Concord-AI/concord-cloud.git/',
    'ssh://git@github.com:22/Get-Concord-AI/concord-cloud.git',
    'github.com/Get-Concord-AI/concord-cloud',
    '  https://github.com/Get-Concord-AI/concord-cloud  ',
  ])('reduces %s to the key every clone shares', (remote) => {
    expect(normalizeProjectKey(remote)).toBe('github.com/get-concord-ai/concord-cloud');
  });

  it.each([
    'git@[2001:db8::1]:org/repo.git',
    'ssh://git@[2001:db8::1]/org/repo.git',
    'https://[2001:db8::1]/Org/Repo',
    'git@[2001:0db8:0:0:0:0:0:1]:org/repo.git',
  ])('reduces an IPv6-hosted remote %s to one key', (remote) => {
    expect(normalizeProjectKey(remote)).toBe('[2001:db8::1]/org/repo');
  });

  it.each([
    'git@github.com:Get-Concord-AI/concord-cloud.git',
    'ssh://git@github.com:22/Get-Concord-AI/concord-cloud.git',
    'git@[2001:db8::1]:org/repo.git',
    'https://[2001:db8::1]/org/repo',
    'git@gitlab.com:acme/platform/api.git',
    'https://example.com/org/repo.git.git',
    'https://example.com/org/repo.git/.git/',
    'git@127.1:org/repo.git',
    'git@example.com:org/repo#one.git',
    'https://example.com/org/my%20repo',
    'https://example.com/org/my%20',
    'https://example.com/org/100%done',
  ])('is stable when applied to its own output (%s)', (remote) => {
    // Clients normalise and the server normalises again, so a key must survive
    // a second pass unchanged or the two would disagree about one repository.
    const once = normalizeProjectKey(remote);
    if (once === null) throw new Error(`${remote} did not normalise`);
    expect(normalizeProjectKey(once)).toBe(once);
  });

  it('keeps a path literal, so different repositories keep different keys', () => {
    expect(normalizeProjectKey('git@example.com:org/repo#one.git')).toBe(
      'example.com/org/repo#one',
    );
    expect(normalizeProjectKey('git@example.com:org/repo?two')).toBe('example.com/org/repo?two');
  });

  it('keeps a URL path escaped', () => {
    expect(normalizeProjectKey('https://example.com/org/my%20repo')).toBe(
      'example.com/org/my%20repo',
    );
    expect(normalizeProjectKey('https://example.com/org/100%done')).toBe(
      'example.com/org/100%done',
    );
  });

  it('spells a host one way however the remote writes it', () => {
    expect(normalizeProjectKey('git@127.1:org/repo.git')).toBe('127.0.0.1/org/repo');
    expect(normalizeProjectKey('ssh://git@127.1/org/repo')).toBe('127.0.0.1/org/repo');
  });

  it('keeps nested group paths', () => {
    expect(normalizeProjectKey('git@gitlab.com:acme/platform/api.git')).toBe(
      'gitlab.com/acme/platform/api',
    );
  });

  it('never carries credentials into the key', () => {
    expect(normalizeProjectKey('https://user:s3cret@example.com/org/repo')).toBe(
      'example.com/org/repo',
    );
  });

  it.each([
    '',
    '   ',
    'repo',
    'https://github.com',
    'https://github.com/',
    'not a url at all',
    '/tmp/repo',
    '/srv/git/acme/app.git',
    './repo',
    '../acme/app',
    '~/src/app',
    'C:\\src\\app',
    'C:/src/app',
    'C:repo.git',
    'c:src/app',
    'file:///srv/git/app.git',
  ])('refuses %j rather than inventing a key that collides', (remote) => {
    expect(normalizeProjectKey(remote)).toBeNull();
  });
});
