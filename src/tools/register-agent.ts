import type { AgentRecord, Repositories } from '../db/index.js';
import type { AgentIdentity } from '../domain/identity.js';
import type { RegisterAgentInput } from '../domain/operations.js';
import { buildRoster, type PresenceEntry } from '../domain/presence.js';

export interface RegisterAgentResult {
  agent: AgentRecord;
  /** True when this call created the agent rather than refreshing it. */
  firstRegistration: boolean;
  /** Every registered agent with derived liveness, most-live first. Includes self. */
  roster: PresenceEntry[];
}

/**
 * Register (or refresh) an agent's presence so concurrent agents are
 * distinguishable and can see who else is active. Returns the resolved identity
 * plus the current roster, so the caller learns who else is here immediately —
 * without a task claim (recon and research agents are visible too).
 *
 * Re-registration is a patch: omitted fields keep their stored value and an
 * explicit `null` clears one.
 *
 * `agent_id` is resolved by the caller from the session (`domain/identity.ts`)
 * and is required. Generating one here is what created agents that no delivery
 * endpoint could ever match: the relay registers endpoints under the
 * session-derived id, so a minted id was addressable but permanently
 * undeliverable.
 */
export function handleRegisterAgent(
  repos: Repositories,
  input: RegisterAgentInput,
  now: number = Date.now(),
): RegisterAgentResult {
  const agentId = input.agent_id;
  const firstRegistration = repos.agents.get(agentId) === undefined;

  const agent = repos.agents.upsert({
    agentId,
    kind: input.kind,
    owner: input.owner,
    model: input.model,
    pid: input.pid,
    cwd: input.cwd,
    worktree: input.worktree,
    branch: input.branch,
    summary: input.summary,
    status: input.status,
  });

  return { agent, firstRegistration, roster: buildRoster(repos.agents.list(), now) };
}

/**
 * Give a resolved session a presence row, and mark it alive.
 *
 * Called by every channel that knows only who it is and nothing about the work
 * — the MCP server at startup, the relay, the SessionStart hooks. For a known
 * session it is only a heartbeat, plus a cwd if none is stored.
 */
export function ensureAgentRegistered(
  repos: Repositories,
  identity: Pick<AgentIdentity, 'agentId' | 'kind'>,
  cwd: string | null = null,
): AgentRecord {
  const existing = repos.agents.get(identity.agentId);
  if (existing === undefined) {
    return repos.agents.upsert({ agentId: identity.agentId, kind: identity.kind, cwd });
  }
  return repos.agents.upsert({
    agentId: existing.agentId,
    kind: existing.kind,
    cwd: existing.cwd === null ? (cwd ?? undefined) : undefined,
  });
}
