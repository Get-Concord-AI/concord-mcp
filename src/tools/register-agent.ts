import { randomBytes } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AgentRecord, Repositories } from '../db/index.js';
import { buildRoster, type PresenceEntry } from '../domain/presence.js';
import { registerAgentInputShape, type RegisterAgentInput } from '../domain/schemas.js';

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

export function formatRegisterAgentText(result: RegisterAgentResult): string {
  const verb = result.firstRegistration ? 'Registered' : 'Refreshed presence';
  const owner = result.agent.owner === null ? '' : ` (owner ${result.agent.owner})`;
  const lines = [`${verb} as ${result.agent.agentId}${owner}.`];

  const others = result.roster.filter((entry) => entry.agentId !== result.agent.agentId);
  if (others.length === 0) {
    lines.push('No other agents are registered yet.');
  } else {
    lines.push(`${String(others.length)} other agent(s) here:`);
    for (const entry of others) {
      const doing = entry.summary ?? 'no summary';
      lines.push(`  - ${entry.agentId} [${entry.liveness}/${entry.status}]: ${doing}`);
    }
  }
  return lines.join('\n');
}

function rosterToStructured(roster: readonly PresenceEntry[]): {
  agent_id: string;
  kind: string;
  owner: string | null;
  summary: string | null;
  status: string;
  liveness: string;
  last_seen: string;
  age_seconds: number;
}[] {
  return roster.map((entry) => ({
    agent_id: entry.agentId,
    kind: entry.kind,
    owner: entry.owner,
    summary: entry.summary,
    status: entry.status,
    liveness: entry.liveness,
    last_seen: entry.lastSeen,
    age_seconds: entry.ageSeconds,
  }));
}

export function registerRegisterAgent(
  server: McpServer,
  repos: Repositories,
  onWrite?: () => void,
): void {
  server.registerTool(
    'register_agent',
    {
      title: 'Register agent',
      description:
        'Register this agent instance so other agents know who you are and what you are working ' +
        'on. Call once at session start (reuse the returned agent_id afterwards) and again to ' +
        'refresh your summary/status. Returns the current roster of active agents. Works without ' +
        'a task claim, so recon and research agents are visible too.',
      inputSchema: registerAgentInputShape,
    },
    (args) => {
      const result = handleRegisterAgent(repos, args);
      onWrite?.();
      return {
        content: [{ type: 'text', text: formatRegisterAgentText(result) }],
        structuredContent: {
          agent_id: result.agent.agentId,
          first_registration: result.firstRegistration,
          status: result.agent.status,
          roster: rosterToStructured(result.roster),
        },
      };
    },
  );
}
