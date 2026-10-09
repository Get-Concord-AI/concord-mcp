import { createHash } from 'node:crypto';

import { z } from 'zod';

/**
 * Who an agent is, derived rather than declared.
 *
 * One session is one agent. Every channel that registers presence — the MCP
 * server, the relay CLI, the SessionStart hooks — derives the same id from the
 * same session, so an agent's identity is the same string no matter which door
 * it came through. Before this module each door minted its own: the MCP surface
 * generated a random id that no delivery endpoint ever matched, so peer messages
 * to it failed `target_not_promptable` forever.
 */

/**
 * A client that reveals its session id in the environment of the processes it
 * spawns, and the kind it registers as.
 *
 * Kind and session id are read from the same entry on purpose. Reading them
 * independently let a Codex hook whose payload was missing fall through to
 * `CLAUDE_CODE_SESSION_ID` and register `codex:<hash of a Claude session>` — an
 * id belonging to no session at all. Pairing them makes that unrepresentable.
 */
export interface SessionSource {
  readonly kind: string;
  readonly envVar: string;
}

/**
 * Clients whose session id reaches a child process.
 *
 * Codex is deliberately absent: it spawns MCP servers with a scrubbed
 * environment (`HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`,
 * `USER` — no session id, not even `PWD`) and passes its session id on stdin to
 * hooks instead. Codex therefore resolves through `hookPayload`, never here.
 */
export const SESSION_SOURCES: readonly SessionSource[] = [
  { kind: 'claude-code', envVar: 'CLAUDE_CODE_SESSION_ID' },
  { kind: 'grok', envVar: 'GROK_SESSION_ID' },
  { kind: 'goose', envVar: 'AGENT_SESSION_ID' },
];

/** How an identity was established, for diagnostics and error messages. */
export type IdentityOrigin = 'operator' | 'session' | 'hook';

export interface AgentIdentity {
  readonly agentId: string;
  readonly kind: string;
  readonly origin: IdentityOrigin;
}

/** The one field we need from any client's hook payload. */
const hookSessionSchema = z
  .object({ session_id: z.string().optional(), sessionId: z.string().optional() })
  .loose();

/**
 * A stable agent id for one session of one client, e.g. `claude-code:4f2a91c7`.
 *
 * Hashed rather than truncated. Codex session ids are UUIDv7, whose leading hex
 * digits are a millisecond clock: the first eight advance only once per ~65
 * seconds, so truncating them gave two Codex sessions started in the same minute
 * the same id — and therefore the same inbox.
 */
export function agentIdForSession(kind: string, sessionId: string): string {
  return `${kind}:${createHash('sha256').update(sessionId).digest('hex').slice(0, 8)}`;
}

/** The session source for a client, when that client exposes one. */
function sourceFor(kind: string | undefined): SessionSource | undefined {
  if (kind === undefined) return undefined;
  return SESSION_SOURCES.find((source) => source.kind === kind);
}

/**
 * Pull the session id out of a hook payload.
 *
 * Codex passes its session id on stdin rather than in the environment, so a
 * Codex hook has no other way to say which agent it is. Never throws: a hook
 * that cannot identify itself should fall through to the other strategies
 * rather than fail the tool call it is attached to.
 */
export function hookSessionId(rawJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  const result = hookSessionSchema.safeParse(parsed);
  if (!result.success) return undefined;
  const sessionId = (result.data.session_id ?? result.data.sessionId)?.trim();
  return sessionId === undefined || sessionId === '' ? undefined : sessionId;
}

export interface ResolveIdentityOptions {
  /** Client the agent runs in. Selects which session source may be read. */
  kind?: string | undefined;
  /** Hook payload JSON, for clients that pass their session id on stdin. */
  hookPayload?: string | undefined;
}

/**
 * Work out which agent this process is, without being told by a model.
 *
 * Returns undefined rather than inventing an identity. A generated id would
 * look registered while being unreachable, which is the failure this module
 * exists to prevent — callers must handle "I don't know" explicitly.
 *
 * `CONCORD_AGENT_ID` wins so a human coordinating agents can name them
 * ("alpha", "reviewer") instead of reading generated slugs. It is set by
 * whoever launches the agent, never by the agent itself.
 */
export function resolveIdentity(
  env: NodeJS.ProcessEnv,
  options: ResolveIdentityOptions = {},
): AgentIdentity | undefined {
  const kind = options.kind;

  const operator = env['CONCORD_AGENT_ID']?.trim();
  if (operator !== undefined && operator !== '') {
    return { agentId: operator, kind: kind ?? kindOf(operator), origin: 'operator' };
  }

  if (options.hookPayload !== undefined) {
    const sessionId = hookSessionId(options.hookPayload);
    if (sessionId !== undefined) {
      const hookKind = kind ?? 'claude-code';
      return { agentId: agentIdForSession(hookKind, sessionId), kind: hookKind, origin: 'hook' };
    }
  }

  // With a kind, only that client's source is consulted; without one (the MCP
  // server, which is told nothing), take whichever source this process was
  // actually launched by.
  const candidates = kind === undefined ? SESSION_SOURCES : [sourceFor(kind)];
  for (const source of candidates) {
    if (source === undefined) continue;
    const sessionId = env[source.envVar]?.trim();
    if (sessionId !== undefined && sessionId !== '') {
      return {
        agentId: agentIdForSession(source.kind, sessionId),
        kind: source.kind,
        origin: 'session',
      };
    }
  }
  return undefined;
}

/** The client prefix of an agent id, for ids supplied whole by an operator. */
function kindOf(agentId: string): string {
  const separator = agentId.indexOf(':');
  return separator === -1 ? 'unknown' : agentId.slice(0, separator);
}

/** What to tell a caller Concord cannot identify. */
export const UNRESOLVED_IDENTITY_MESSAGE =
  'Concord cannot tell which session you are. Run `concord inbox register` and pass the ' +
  'agent_id it prints, or set CONCORD_AGENT_ID before starting this session.';

/**
 * Which agent a tool call is acting as.
 *
 * A resolved session identity always beats a supplied one: a model must not be
 * able to act as — or send messages as — another agent by passing its id. The
 * supplied id is honoured only where Concord genuinely cannot see the session,
 * which today means Codex, whose hooks tell the model the id to pass back.
 */
export function resolveActorId(
  session: AgentIdentity | undefined,
  supplied: string | undefined,
): string {
  if (session !== undefined) return session.agentId;
  const given = supplied?.trim();
  if (given !== undefined && given !== '') return given;
  throw new Error(UNRESOLVED_IDENTITY_MESSAGE);
}
