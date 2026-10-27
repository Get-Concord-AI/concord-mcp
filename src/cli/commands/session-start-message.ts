import { antigravityMonitorCommand } from '../../domain/antigravity-monitor.js';

export interface RosterLine {
  readonly agentId: string;
  readonly liveness: string;
  readonly status: string;
  readonly summary: string | null;
}

/** Format the roster of other agents into display lines. */
export function rosterLines(others: readonly RosterLine[]): string[] {
  if (others.length === 0) {
    return ['No other agents are currently registered.'];
  }
  return [
    'Who else is here:',
    ...others.map(
      (entry) =>
        `  - ${entry.agentId} [${entry.liveness}/${entry.status}]: ${entry.summary ?? '-'}`,
    ),
  ];
}

/** What a session is told at start: who it is, and who else is here. */
export function sessionStartMessage(
  agentId: string,
  others: readonly RosterLine[],
  explicitAgentId = false,
): string {
  return [
    explicitAgentId
      ? `Concord: this session is agent \`${agentId}\`. Devin's MCP server cannot see the hook session payload, so include \`agent_id: "${agentId}"\` on start_work, update_work, transfer_work, and finish_work calls. Leave it off inspect_work, where \`agent_id\` selects an agent inbox. Do not invent an id.`
      : `Concord: this session is agent \`${agentId}\`. Concord resolves that identity from your ` +
        'session on every tool call, so start_work, update_work, finish_work attribute your work ' +
        'and keep your presence live without you passing an id.',
    'You can receive live messages from other agents in this workspace; they arrive on their own ' +
      'as relayed context, so you never need to poll for them.',
    ...rosterLines(others),
  ].join('\n');
}

/**
 * Antigravity's MCP server cannot see the session, so the id must be passed explicitly on writes.
 * Hooks only reach a running turn; an idle session hears peers through a one-shot background
 * monitor whose completion wakes it.
 */
export function antigravitySessionStartMessage(
  agentId: string,
  others: readonly RosterLine[],
): string {
  const monitor = antigravityMonitorCommand(agentId);
  return [
    `Concord: this session is agent \`${agentId}\`. Pass agent_id: "${agentId}" on every ` +
      'write call (start_work, update_work, transfer_work, finish_work). ' +
      'The MCP server cannot see your session, so it cannot fill this in for you.',
    'Messages from other agents reach a running turn automatically. To hear them while idle, ' +
      `start exactly one background command now: \`${monitor}\`. Do not wait on it or ` +
      'poll it. When it completes with a message, answer it, then immediately start a fresh ' +
      'one with the same command.',
    ...rosterLines(others),
  ].join('\n');
}
