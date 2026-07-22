import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories, TaskRecord } from '../db/index.js';
import { detectOverlaps, type OverlapWarning } from '../domain/overlap.js';
import { claimWorkInputShape, type ClaimWorkInput } from '../domain/schemas.js';

export interface ClaimWorkResult {
  task: TaskRecord;
  alreadyClaimed: boolean;
  overlaps: OverlapWarning[];
  /**
   * How many other active tasks the overlap check compared against. Overlap
   * detection is point-in-time: an empty `overlaps` only means nothing conflicts
   * *right now*. A later overlapping claim will not appear here — it surfaces on
   * read (e.g. `concord status`), which recomputes overlaps live.
   */
  checkedAgainst: number;
}

/**
 * Record that an agent is working on a task and flag any overlaps with other
 * active tasks. Idempotent: re-claiming an existing task returns it unchanged.
 */
export function handleClaimWork(repos: Repositories, input: ClaimWorkInput): ClaimWorkResult {
  const activeOthers = repos.tasks
    .list()
    .filter((task) => task.taskId !== input.task_id && task.status === 'active');

  const overlaps = detectOverlaps(
    {
      taskId: input.task_id,
      expectedFiles: input.expected_files ?? [],
      modules: input.modules ?? [],
      domains: input.domains ?? [],
      riskTags: input.risk_tags ?? [],
    },
    activeOthers,
  );

  const existing = repos.tasks.get(input.task_id);
  const task =
    existing ??
    repos.tasks.create({
      taskId: input.task_id,
      title: input.title,
      owner: input.owner ?? null,
      agent: input.agent ?? null,
      branch: input.branch ?? null,
      worktree: input.worktree ?? null,
      expectedFiles: input.expected_files ?? [],
      modules: input.modules ?? [],
      domains: input.domains ?? [],
      riskTags: input.risk_tags ?? [],
      notes: input.notes ?? null,
    });

  repos.events.record({
    taskId: input.task_id,
    tool: 'claim_work',
    status: 'success',
    detail: overlaps.length > 0 ? `${String(overlaps.length)} overlap(s)` : null,
  });

  return {
    task,
    alreadyClaimed: existing !== undefined,
    overlaps,
    checkedAgainst: activeOthers.length,
  };
}

export function formatClaimWorkText(result: ClaimWorkResult): string {
  const verb = result.alreadyClaimed ? 'Already claimed' : 'Claimed';
  const lines = [`${verb} ${result.task.taskId} (${result.task.title}).`];

  if (result.overlaps.length === 0) {
    if (result.checkedAgainst === 0) {
      lines.push(
        'No other active claims to check against yet. Overlaps are only checked at ' +
          'claim time, so a later overlapping claim will not appear here — run ' +
          '`concord status` to re-check as others claim work.',
      );
    } else {
      lines.push(
        `No overlaps with the ${String(result.checkedAgainst)} other active task(s) at claim time. ` +
          'This is a point-in-time check — run `concord status` to re-check as new work is claimed.',
      );
    }
    return lines.join('\n');
  }

  lines.push(
    `Potential overlaps (${String(result.overlaps.length)} of ${String(result.checkedAgainst)} active task(s)):`,
  );
  for (const overlap of result.overlaps) {
    lines.push(`  - ${overlap.taskId} (${overlap.title}): ${overlap.reasons.join('; ')}`);
  }
  return lines.join('\n');
}

export function registerClaimWork(
  server: McpServer,
  repos: Repositories,
  onWrite?: () => void,
): void {
  server.registerTool(
    'claim_work',
    {
      title: 'Claim work',
      description:
        'Record that an agent is starting a task and flag overlaps with other active tasks. ' +
        'Call this before editing code. Overlap detection is point-in-time (only against tasks ' +
        'already active at claim time); run `concord status` to re-check as others claim.',
      inputSchema: claimWorkInputShape,
    },
    (args) => {
      const result = handleClaimWork(repos, args);
      onWrite?.();
      return {
        content: [{ type: 'text', text: formatClaimWorkText(result) }],
        structuredContent: {
          task_id: result.task.taskId,
          already_claimed: result.alreadyClaimed,
          overlaps: result.overlaps,
          // Number of other active tasks compared against. With an empty
          // `overlaps`, this disambiguates "nobody else was active" (0) from
          // "compared against N, none conflict" — the check is point-in-time.
          checked_against: result.checkedAgainst,
        },
      };
    },
  );
}
