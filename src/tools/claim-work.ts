import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories, TaskRecord } from '../db/index.js';
import { assessClaimBreadth } from '../domain/decomposition.js';
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
  /**
   * Advisory reasons the claim looks too broad (empty when appropriately
   * scoped). A non-empty list is a suggestion to split the work into smaller,
   * independently-handoffable tasks — never a rejection.
   */
  breadthReasons: string[];
  /**
   * On a re-claim, the scope entries this call added to the existing claim
   * (e.g. `module: api-client`, `file: lib/todo-api.ts`). Empty on a first
   * claim or when nothing new was declared.
   */
  scopeAdded: string[];
}

/** Union of two label lists, de-duplicated, existing entries first. */
function mergeUnique(existing: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

/** Entries in `incoming` not already present in `existing`. */
function addedEntries(existing: readonly string[], incoming: readonly string[]): string[] {
  const have = new Set(existing);
  return [...new Set(incoming.filter((value) => !have.has(value)))];
}

/**
 * Record that an agent is working on a task and flag overlaps with other active
 * tasks. Re-claiming an existing task is idempotent for its identity (title,
 * owner, agent) but *extends* its declared scope: the new files/modules/domains/
 * risk tags are merged in and persisted, overlaps are recomputed against the
 * merged scope, and the additions are reported back.
 */
export function handleClaimWork(repos: Repositories, input: ClaimWorkInput): ClaimWorkResult {
  const inputFiles = input.expected_files ?? [];
  const inputModules = input.modules ?? [];
  const inputDomains = input.domains ?? [];
  const inputRiskTags = input.risk_tags ?? [];

  const existing = repos.tasks.get(input.task_id);

  // Parent is set at first claim and preserved thereafter (identity is idempotent).
  const parentTaskId = existing ? existing.parentTaskId : (input.parent_task_id ?? null);

  // Effective scope: the merged surface for an existing claim, else the input.
  const scope = {
    expectedFiles: existing ? mergeUnique(existing.expectedFiles, inputFiles) : inputFiles,
    modules: existing ? mergeUnique(existing.modules, inputModules) : inputModules,
    domains: existing ? mergeUnique(existing.domains, inputDomains) : inputDomains,
    riskTags: existing ? mergeUnique(existing.riskTags, inputRiskTags) : inputRiskTags,
  };

  const activeOthers = repos.tasks
    .list()
    .filter((task) => task.taskId !== input.task_id && task.status === 'active');

  const overlaps = detectOverlaps({ taskId: input.task_id, parentTaskId, ...scope }, activeOthers);

  const scopeAdded = existing
    ? [
        ...addedEntries(existing.expectedFiles, inputFiles).map((value) => `file: ${value}`),
        ...addedEntries(existing.modules, inputModules).map((value) => `module: ${value}`),
        ...addedEntries(existing.domains, inputDomains).map((value) => `domain: ${value}`),
        ...addedEntries(existing.riskTags, inputRiskTags).map((value) => `risk tag: ${value}`),
      ]
    : [];

  let task: TaskRecord;
  if (existing === undefined) {
    task = repos.tasks.create({
      taskId: input.task_id,
      title: input.title,
      owner: input.owner ?? null,
      agent: input.agent ?? null,
      branch: input.branch ?? null,
      worktree: input.worktree ?? null,
      ...scope,
      notes: input.notes ?? null,
      parentTaskId,
    });
  } else if (scopeAdded.length > 0) {
    task = repos.tasks.updateScope(input.task_id, scope) ?? existing;
  } else {
    task = existing;
  }

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
    breadthReasons: assessClaimBreadth(scope),
    scopeAdded,
  };
}

export function formatClaimWorkText(result: ClaimWorkResult): string {
  const verb = result.alreadyClaimed ? 'Already claimed' : 'Claimed';
  const lines = [`${verb} ${result.task.taskId} (${result.task.title}).`];

  if (result.alreadyClaimed && result.scopeAdded.length > 0) {
    lines.push(`Extended claim scope (added ${result.scopeAdded.join(', ')}).`);
  }

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
  } else {
    lines.push(
      `Potential overlaps (${String(result.overlaps.length)} of ${String(result.checkedAgainst)} active task(s)):`,
    );
    for (const overlap of result.overlaps) {
      lines.push(`  - ${overlap.taskId} (${overlap.title}): ${overlap.reasons.join('; ')}`);
    }
  }

  if (result.breadthReasons.length > 0) {
    lines.push(
      `Heads-up: this claim looks broad (${result.breadthReasons.join('; ')}). ` +
        'Consider splitting it into smaller, independently-handoffable tasks and claiming each separately.',
    );
  }

  return lines.join('\n');
}

/** The `claim_work` MCP structured output. All keys are snake_case, including
 * overlap entries, so the payload is internally consistent. */
export function toClaimWorkStructured(result: ClaimWorkResult): {
  task_id: string;
  parent_task_id: string | null;
  already_claimed: boolean;
  overlaps: { task_id: string; title: string; reasons: string[] }[];
  checked_against: number;
  breadth_reasons: string[];
  scope_added: string[];
} {
  return {
    task_id: result.task.taskId,
    parent_task_id: result.task.parentTaskId,
    already_claimed: result.alreadyClaimed,
    overlaps: result.overlaps.map((overlap) => ({
      task_id: overlap.taskId,
      title: overlap.title,
      reasons: overlap.reasons,
    })),
    checked_against: result.checkedAgainst,
    breadth_reasons: result.breadthReasons,
    scope_added: result.scopeAdded,
  };
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
        structuredContent: toClaimWorkStructured(result),
      };
    },
  );
}
