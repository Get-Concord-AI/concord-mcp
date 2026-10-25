import {
  agentIdForSession,
  resolveIdentity,
  UNRESOLVED_IDENTITY_MESSAGE,
  type AgentIdentity,
  type ResolveIdentityOptions,
} from '../domain/identity.js';

/**
 * The CLI's view of identity. Derivation itself lives in `domain/identity.ts`
 * so the MCP server resolves the *same* id from the same session — these are
 * two doors into one agent, not two agents.
 */

/**
 * Work out which agent a CLI invocation is acting as.
 *
 * An explicit `--agent` wins: it is typed by a human or written into a hook
 * command, so it carries operator intent the way `CONCORD_AGENT_ID` does.
 * Throws rather than generating an id — an invented id looks registered while
 * being unreachable.
 */
export function resolveAgentId(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveIdentityOptions = {},
): string {
  const given = explicit?.trim();
  if (given !== undefined && given !== '') return given;

  const identity = resolveIdentity(env, options);
  if (identity === undefined) {
    throw new Error(UNRESOLVED_IDENTITY_MESSAGE);
  }
  return identity.agentId;
}

/**
 * The identity for a Claude Code SessionStart payload. Falls back to the
 * environment when the payload carries no session id, so a hook that fires with
 * an unexpected shape still lands on this session's real id.
 */
export function sessionStartIdentity(
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AgentIdentity | undefined {
  const operator = env['CONCORD_AGENT_ID']?.trim();
  if (operator === undefined || operator === '') {
    const trimmed = sessionId?.trim();
    if (trimmed !== undefined && trimmed !== '') {
      return {
        agentId: agentIdForSession('claude-code', trimmed),
        kind: 'claude-code',
        origin: 'session',
      };
    }
  }
  return resolveIdentity(env, { kind: 'claude-code' });
}

/**
 * The agent whose inbox this process may take messages from. Draining marks
 * messages delivered, so naming another agent with `--agent` would consume its
 * mail: when this process can see its own session, `--agent` must agree with
 * it. Where no session is visible (a Grok or Cursor monitor, a script), the
 * named agent is trusted, as everywhere else Concord cannot see the caller.
 */
export function resolveInboxOwner(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveIdentityOptions = {},
): string {
  const agentId = resolveAgentId(explicit, env, options);
  const own = resolveIdentity(env, options);
  if (own !== undefined && own.agentId !== agentId) {
    throw new Error(
      `This session is agent ${own.agentId}; it cannot take messages addressed to ${agentId}.`,
    );
  }
  return agentId;
}
