export interface RosterLine {
  readonly agentId: string;
  readonly liveness: string;
  readonly status: string;
  readonly summary: string | null;
}

/** What a session is told at start: who it is, and who else is here. */
export function sessionStartMessage(agentId: string, others: readonly RosterLine[]): string {
  const lines = [
    `Concord: this session is agent \`${agentId}\`. Concord resolves that identity from your ` +
      'session on every tool call, so start_work, update_work, finish_work attribute your work ' +
      'and keep your presence live without you passing an id.',
    'You can receive live messages from other agents in this workspace; they arrive on their own ' +
      'as relayed context, so you never need to poll for them.',
  ];
  if (others.length === 0) {
    lines.push('No other agents are currently registered.');
  } else {
    lines.push('Who else is here:');
    for (const entry of others) {
      lines.push(
        `  - ${entry.agentId} [${entry.liveness}/${entry.status}]: ${entry.summary ?? '-'}`,
      );
    }
  }
  return lines.join('\n');
}
