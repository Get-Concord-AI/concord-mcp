import type { PresenceEntry } from './presence.js';

function formatAge(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
  return `${String(Math.floor(seconds / 3600))}h`;
}

function presenceSignals(entry: PresenceEntry): string {
  const activity =
    entry.activityAgeSeconds === null
      ? 'no activity'
      : `activity ${formatAge(entry.activityAgeSeconds)} ago`;
  const summary =
    entry.summaryAgeSeconds === null ? '' : `, summary ${formatAge(entry.summaryAgeSeconds)} old`;
  return `heartbeat ${formatAge(entry.heartbeatAgeSeconds)} ago, ${activity}${summary}`;
}

/** Render the presence roster as indented lines, or a placeholder when empty. */
export function renderRosterLines(roster: readonly PresenceEntry[]): string[] {
  if (roster.length === 0) return ['  none'];
  return roster.map((entry) => {
    const state = `${entry.liveness}/${entry.status}`;
    const doing = entry.summary ?? '-';
    return `  ${entry.agentId.padEnd(18)} ${state.padEnd(20)} ${doing}  (${presenceSignals(entry)})`;
  });
}
