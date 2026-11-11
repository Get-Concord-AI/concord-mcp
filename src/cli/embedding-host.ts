/**
 * Apps that run coding agents inside their own UI, detected from the
 * environment they give the agent's processes (hooks included).
 *
 * Conductor (https://www.conductor.build) sets `CONDUCTOR_SESSION_ID` in every
 * agent process it launches, documented at
 * https://www.conductor.build/docs/reference/environment-variables. It drives
 * Codex through its own `codex app-server` over stdio and Claude Code through
 * the Claude Agent SDK, so Concord's terminal adapters must not assume they
 * own the session.
 */
export type EmbeddingHost = 'conductor';

export function embeddingHost(env: NodeJS.ProcessEnv): EmbeddingHost | undefined {
  // Set only in the agent processes Conductor launches, not in its terminals,
  // where a user may run an agent CLI of their own.
  const sessionId = env['CONDUCTOR_SESSION_ID']?.trim();
  return sessionId !== undefined && sessionId !== '' ? 'conductor' : undefined;
}

/**
 * Whether Concord's managed Codex app-server may host this Codex thread.
 *
 * The host resumes the thread in Concord's own daemon and starts turns there.
 * When another app's app-server owns the thread, those turns would run in a
 * second process its UI never shows, writing the same rollout. Such sessions
 * get hook delivery (PostToolUse and Stop) instead.
 */
export function codexThreadHostable(env: NodeJS.ProcessEnv): boolean {
  return embeddingHost(env) === undefined;
}
