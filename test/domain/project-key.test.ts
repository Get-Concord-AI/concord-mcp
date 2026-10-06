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
  ])('reduces an IPv6-hosted remote %s to one key', (remote) => {
    expect(normalizeProjectKey(remote)).toBe('[2001:db8::1]/org/repo');
  });

  it.each([
    'git@github.com:Get-Concord-AI/concord-cloud.git',
    'ssh://git@github.com:22/Get-Concord-AI/concord-cloud.git',
    'git@[2001:db8::1]:org/repo.git',
    'https://[2001:db8::1]/org/repo',
    'git@gitlab.com:acme/platform/api.git',
  ])('is stable when applied to its own output (%s)', (remote) => {
    // Clients normalise and the server normalises again, so a key must survive
    // a second pass unchanged or the two would disagree about one repository.
    const once = normalizeProjectKey(remote);
    if (once === null) throw new Error(`${remote} did not normalise`);
    expect(normalizeProjectKey(once)).toBe(once);
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

  it.each(['', '   ', 'repo', 'https://github.com', 'https://github.com/', 'not a url at all'])(
    'refuses %j rather than inventing a key that collides',
    (remote) => {
      expect(normalizeProjectKey(remote)).toBeNull();
    },
  );
});
