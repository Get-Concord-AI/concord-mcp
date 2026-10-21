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
export function sessionStartMessage(agentId: string, others: readonly RosterLine[]): string {
  return [
    `Concord: this session is agent \`${agentId}\`. Concord resolves that identity from your ` +
      'session on every tool call, so start_work, update_work, finish_work attribute your work ' +
      'and keep your presence live without you passing an id.',
    'You can receive live messages from other agents in this workspace; they arrive on their own ' +
      'as relayed context, so you never need to poll for them.',
    ...rosterLines(others),
  ].join('\n');
}

/** Antigravity's MCP server cannot see the session, so the id must be passed explicitly on writes. */
export function antigravitySessionStartMessage(
  agentId: string,
  others: readonly RosterLine[],
): string {
  return [
    `Concord: this session is agent \`${agentId}\`. Pass agent_id: "${agentId}" on every ` +
      'write call (start_work, update_work, transfer_work, finish_work). ' +
      'The MCP server cannot see your session, so it cannot fill this in for you.',
    'Messages from other agents in this workspace are delivered into your turns automatically; ' +
      'you never need to poll for them.',
    ...rosterLines(others),
  ].join('\n');
}
