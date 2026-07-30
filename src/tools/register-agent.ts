import { randomBytes } from 'node:crypto';

import type { AgentRecord, Repositories } from '../db/index.js';
import type { RegisterAgentInput } from '../domain/operations.js';
import { buildRoster, type PresenceEntry } from '../domain/presence.js';

export interface RegisterAgentResult {
  agent: AgentRecord;
  /** True when this call created the agent rather than refreshing it. */
  firstRegistration: boolean;
  /** Every registered agent with derived liveness, most-live first. Includes self. */
  roster: PresenceEntry[];
}

/** A short, human-typable instance id, e.g. `claude-code:7p8v`. Generated when
 * the caller does not supply one; returned so it can be reused thereafter. */
export function generateAgentId(kind: string): string {
  return `${kind}:${randomBytes(2).toString('hex')}`;
}

/**
 * Register (or refresh) an agent's presence so concurrent agents are
 * distinguishable and can see who else is active. Returns the resolved identity
 * plus the current roster, so the caller learns who else is here immediately —
 * without a task claim (recon and research agents are visible too).
 */
export function handleRegisterAgent(
  repos: Repositories,
  input: RegisterAgentInput,
  now: number = Date.now(),
): RegisterAgentResult {
  const agentId = input.agent_id ?? generateAgentId(input.kind);
  const firstRegistration = repos.agents.get(agentId) === undefined;

  const agent = repos.agents.upsert({
    agentId,
    kind: input.kind,
    owner: input.owner ?? null,
    model: input.model ?? null,
    pid: input.pid ?? null,
    cwd: input.cwd ?? null,
    worktree: input.worktree ?? null,
    branch: input.branch ?? null,
    summary: input.summary ?? null,
    status: input.status ?? 'active',
  });

  return { agent, firstRegistration, roster: buildRoster(repos.agents.list(), now) };
}
