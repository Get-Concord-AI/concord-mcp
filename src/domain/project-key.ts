/**
 * A repository's identity in the cloud: its git remote, reduced to the part
 * every clone agrees on.
 *
 * The same repository is cloned as `git@github.com:Org/Repo.git` on one machine
 * and `https://github.com/org/repo` on another. Both must name one project, or
 * two agents in the same repository would never see each other's claims. So
 * scheme, credentials, port, a trailing `.git` and slashes are dropped, the scp
 * form (`host:path`) becomes `host/path`, and the whole key is lowercased —
 * the major hosts treat owner and repository names case-insensitively.
 *
 * Returns null for anything that does not reduce to a host and a path, so a
 * caller refuses it rather than storing a key that collides by accident (`""`,
 * or a bare word every repository without a remote would share).
 *
 * A mirror of Concord Cloud's `normalizeProjectKey` (concord-cloud
 * `packages/domain/src/project-key.ts`): the cloud names a repository by this
 * key, and the local runtime must compute the same one from `git remote` so an
 * agent's repository and the cloud's agree. The server normalises again, so a
 * mismatch here would only mean asking about a repository nobody uses — keep
 * the two in step, with the same tests.
 */
export function normalizeProjectKey(remote: string): string | null {
  let value = remote.trim();

  if (value === '') {
    return null;
  }

  // scp-like syntax: [user@]host:path — no scheme, and a colon before any slash.
  // A bracketed IPv6 host is matched whole, or its own colons would be taken
  // for the separator and two spellings of one remote would become two keys.
  const scp = /^(?:[^@/[]+@)?(\[[^\]]+\]|[^:/[]+):(?!\/)(.+)$/.exec(value);

  if (scp !== null && !value.includes('://')) {
    value = `${scp[1] ?? ''}/${scp[2] ?? ''}`;
  } else {
    try {
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      value = `${url.hostname}${url.pathname}`;
    } catch {
      return null;
    }
  }

  const key = value
    .toLowerCase()
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

  const [host, ...path] = key.split('/');

  if (host === undefined || host === '' || path.length === 0 || path.some((part) => part === '')) {
    return null;
  }

  return key;
}
