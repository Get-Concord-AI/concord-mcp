import { execFileSync } from 'node:child_process';

/**
 * Resolve the human owner to record when `start_work` does not name one.
 *
 * A task whose `owner` is null has no supervisor: if its claiming session ends,
 * no other agent can ever force-reassign, reopen, or close it (see
 * `isHumanSupervisor` in tools/task-lifecycle.ts). Sessions routinely forget to
 * pass `owner`, so the server resolves a workspace default once at startup —
 * `CONCORD_DEFAULT_OWNER` from the environment, else the repository's
 * `git config user.name` — and applies it wherever a registration or claim
 * arrives ownerless. An explicit `owner` on the call always wins.
 */
export function resolveDefaultOwner(env: NodeJS.ProcessEnv, repoRoot: string): string | null {
  const fromEnv = env['CONCORD_DEFAULT_OWNER']?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const name = execFileSync('git', ['-C', repoRoot, 'config', 'user.name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}
