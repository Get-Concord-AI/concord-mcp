import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The longest Unix-domain socket path `listen` accepts: `sun_path` is 104
 * bytes on macOS and the BSDs and 108 on Linux, including the closing NUL.
 */
export const MAX_SOCKET_PATH = process.platform === 'linux' ? 107 : 103;

/** A short deterministic endpoint avoids Unix socket path-length limits. */
export function relayAddress(
  concordPath: string,
  agentId: string,
  base: string = tmpdir(),
): string {
  const slug = createHash('sha256').update(`${concordPath}\0${agentId}`).digest('hex').slice(0, 24);
  if (process.platform === 'win32') return `\\\\.\\pipe\\concord-${slug}`;
  // Repository paths routinely exceed the socket limit, so the socket lives in
  // a user-owned runtime directory under the temp directory instead. A host
  // can inherit a long temp directory, though — Copilot CLI runs hooks with
  // `TMPDIR=/tmp/copilot-<uuid>/` — and then `/tmp` is used.
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  const name = `concord-relay-${user}`;
  const socket = `${slug}.sock`;
  const directory =
    Buffer.byteLength(join(base, name, socket)) <= MAX_SOCKET_PATH
      ? join(base, name)
      : join('/tmp', name);
  privateDirectory(directory);
  return join(directory, socket);
}

/** Create `directory` for this user only, refusing one another user made first in a shared /tmp. */
function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  const ownedByOther = typeof process.getuid === 'function' && stat.uid !== process.getuid();
  if (!stat.isDirectory() || ownedByOther) {
    throw new Error(`Refusing to use a relay directory this user does not own: ${directory}`);
  }
  chmodSync(directory, 0o700);
}
