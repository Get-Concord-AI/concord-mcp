/**
 * A host as the WHATWG URL parser spells it for `https`: lowercased, IPv6
 * compressed, shortened IPv4 expanded. One parser for every form of remote, so
 * a key normalised twice is unchanged.
 */
function normalizeHost(host: string): string | null {
  try {
    return new URL(`https://${host}/`).hostname;
  } catch {
    return null;
  }
}

/**
 * A URL path as the URL parser spells it, with every `%` that begins no escape
 * written `%25`: one spelling of each path, however it arrived, and unchanged
 * by a second pass.
 */
function urlPath(escaped: string): string | null {
  try {
    const path = new URL(`https://host/${escaped}`).pathname;
    return path.replace(/%(?![0-9a-f]{2})/gi, '%25');
  } catch {
    return null;
  }
}

/** The host and path a remote names, in whichever of git's forms it is written. */
function splitRemote(value: string): { host: string; path: string | null } | null {
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      // Kept escaped: decoding would let a key change on a second pass.
      return { host: url.hostname, path: urlPath(url.pathname.slice(1)) };
    } catch {
      return null;
    }
  }

  // scp-like syntax: [user@]host:path — no scheme, and a colon before any slash.
  // A bracketed IPv6 host is matched whole, or its own colons would be taken
  // for the separator. Its path is literal, so every character a URL path
  // would read specially is escaped first: `repo#one`, `repo%23one` and
  // `repo\one` are three repositories, and `repo#one` is the URL's `repo%23one`.
  const scp = /^(?:[^@/[]+@)?(\[[^\]]+\]|[^:/[]+):(?!\/)(.+)$/.exec(value);
  if (scp !== null) {
    return {
      host: scp[1] ?? '',
      path: urlPath((scp[2] ?? '').replace(/[%\\#?]/g, encodeURIComponent)),
    };
  }

  // host/path, as a key itself is written: already escaped.
  const slash = value.indexOf('/');
  return slash === -1
    ? null
    : { host: value.slice(0, slash), path: urlPath(value.slice(slash + 1)) };
}

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
  const value = remote.trim();

  // A filesystem path is a remote too (`git clone /srv/repo`, or `C:repo` on
  // Windows), but not one that names the same repository on every machine.
  if (value === '' || /^(?:[/\\~.]|[a-z]:)/i.test(value)) {
    return null;
  }

  const remoteParts = splitRemote(value);
  if (remoteParts === null || remoteParts.path === null) {
    return null;
  }
  const remoteHost = normalizeHost(remoteParts.host);
  if (remoteHost === null || remoteHost === '') {
    return null;
  }

  // Trailing slashes and `.git` are stripped together, however they repeat.
  const key = `${remoteHost}/${remoteParts.path}`
    .toLowerCase()
    .replace(/\/+/g, '/')
    .replace(/(?:\/|\.git)+$/, '');

  const [host, ...path] = key.split('/');

  if (host === undefined || host === '' || path.length === 0 || path.some((part) => part === '')) {
    return null;
  }

  return key;
}
