import type { Repositories } from '../db/index.js';
import { ancestorPids } from '../parent-chain.js';

/**
 * Record that this hook's client hosts `identity` — one row per ancestor pid,
 * because a client that wraps hooks in a shell is not the pid its MCP servers
 * see. The chain is rewritten on every session-start fire: rows this agent
 * left for older hook shells (a returning session after A → B → A) are dropped
 * first, so only the current client's lineage points at it.
 */
export function recordClientBinding(
  repos: Repositories,
  identity: { agentId: string; kind: string },
  pids: readonly number[] = ancestorPids(),
): void {
  const at = new Date().toISOString();
  repos.sessionBindings.removeForAgent(identity.agentId);
  for (const pid of pids) {
    repos.sessionBindings.upsert(pid, identity.agentId, identity.kind, at);
  }
}
