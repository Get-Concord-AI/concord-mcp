import type { Repositories } from '../db/index.js';
import { ancestorPids } from '../parent-chain.js';

/**
 * Record that this hook's client hosts `identity` — one row per ancestor pid,
 * because a client that wraps hooks in a shell is not the pid its MCP servers
 * see. Cheap path first: refreshing rows this agent already owns needs no
 * process-table read, so only a first recording (which is exactly what a new
 * session id after /resume is) pays for the ancestor walk.
 */
export function recordClientBinding(
  repos: Repositories,
  identity: { agentId: string; kind: string },
  pids?: readonly number[],
): void {
  if (repos.sessionBindings.touch(identity.agentId) > 0) return;
  const at = new Date().toISOString();
  for (const pid of pids ?? ancestorPids()) {
    repos.sessionBindings.upsert(pid, identity.agentId, identity.kind, at);
  }
}
