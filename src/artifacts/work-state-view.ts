import { dirname } from 'node:path';

import type { Repositories, TaskRecord, TaskStatus } from '../db/index.js';
import { effectiveEndpointCapabilities } from '../domain/delivery.js';
import { detectOverlaps } from '../domain/overlap.js';
import { endpointPromptable } from '../tools/agent-messages.js';
import {
  buildRoster,
  detectStaleClaims,
  type PresenceEntry,
  type StaleClaim,
} from '../domain/presence.js';

interface ActiveEntry {
  taskId: string;
  agent: string;
  agentId: string | null;
  assignedAgentId: string | null;
  status: string;
  version: number;
  updatedAt: string;
  branch: string;
  touches: string;
  parentTaskId: string | null;
}

interface OverlapPair {
  a: string;
  b: string;
  reasons: string[];
}

interface ReviewEntry {
  taskId: string;
  testsCount: number;
  guardrailsCount: number;
  openQuestionCount: number;
}

interface OpenQuestionEntry {
  taskId: string;
  question: string;
}

interface CommunicationEntry {
  agentId: string;
  promptable: boolean;
  provider: string | null;
  capabilities: string[];
}

/** A read-only snapshot of shared work-state: active claims, overlaps computed
 * live across all active tasks, and review-ready tasks with their open
 * questions. Rendered by both the CLI (`concord status`) and the
 * `get_work_state` MCP tool / `concord://work-state` resource. */
export interface StatusView {
  active: ActiveEntry[];
  overlaps: OverlapPair[];
  reviewReady: ReviewEntry[];
  openQuestions: OpenQuestionEntry[];
  /** Registered agents with derived liveness — "who is here and what they are
   * doing", most-live first. */
  presence: PresenceEntry[];
  /** Active claims whose owning agent has gone away or never registered. */
  staleClaims: StaleClaim[];
  /** Prompt addressability without exposing provider session handles. */
  communications: CommunicationEntry[];
}

const ACTIVE_STATUSES = [
  'assigned',
  'active',
  'blocked',
  'handoff_offered',
] as const satisfies readonly TaskStatus[];
const STATUS_VIEW_STATUSES = [
  ...ACTIVE_STATUSES,
  'review_ready',
] as const satisfies readonly TaskStatus[];

function touchesOf(task: TaskRecord): string {
  const values = task.modules.length > 0 ? task.modules : task.expectedFiles.map((f) => dirname(f));
  const unique = [...new Set(values.filter((v) => v !== '.' && v !== ''))];
  return unique.length > 0 ? unique.join(', ') : '-';
}

export function buildStatus(repos: Repositories, now: number = Date.now()): StatusView {
  // Status only renders active/review-ready tasks. Keep historical completed/closed
  // rows out of the hot path so long-lived workspaces do not pay to parse them.
  const tasks = repos.tasks.listByStatuses(STATUS_VIEW_STATUSES);
  const agents = repos.agents.list();
  const endpointsByAgent = new Map(
    repos.agentEndpoints.list().map((endpoint) => [endpoint.agentId, endpoint] as const),
  );
  const activeStatuses = new Set<TaskStatus>(ACTIVE_STATUSES);
  const active = tasks.filter((task) => activeStatuses.has(task.status));

  const overlaps: OverlapPair[] = [];
  // Overlap is symmetric. Scan only the upper triangle so every task pair is
  // evaluated once instead of A->B and B->A, and no deduplication set is needed.
  for (let index = 0; index < active.length; index += 1) {
    const task = active[index];
    if (task === undefined) continue;
    for (const warning of detectOverlaps(
      {
        taskId: task.taskId,
        expectedFiles: task.expectedFiles,
        modules: task.modules,
        domains: task.domains,
        riskTags: task.riskTags,
        parentTaskId: task.parentTaskId,
      },
      active,
      index + 1,
    )) {
      overlaps.push({ a: task.taskId, b: warning.taskId, reasons: warning.reasons });
    }
  }

  const reviewTasks = tasks.filter((task) => task.status === 'review_ready');
  const latestReviews = new Map(
    repos.reviews
      .latestForTasks(reviewTasks.map((task) => task.taskId))
      .map((review) => [review.taskId, review] as const),
  );
  const reviewReady: ReviewEntry[] = [];
  const openQuestions: OpenQuestionEntry[] = [];
  for (const task of reviewTasks) {
    const review = latestReviews.get(task.taskId);
    if (review === undefined) {
      continue;
    }
    reviewReady.push({
      taskId: task.taskId,
      testsCount: review.testsRun.length,
      guardrailsCount: review.guardrailsChecked.length,
      openQuestionCount: review.openQuestions.length,
    });
    for (const question of review.openQuestions) {
      openQuestions.push({ taskId: task.taskId, question });
    }
  }

  return {
    active: active.map((task) => ({
      taskId: task.taskId,
      agent: task.agent ?? '-',
      agentId: task.agentId,
      assignedAgentId: task.assignedAgentId,
      status: task.status,
      version: task.version,
      updatedAt: task.updatedAt,
      branch: task.branch ?? '-',
      touches: touchesOf(task),
      parentTaskId: task.parentTaskId,
    })),
    overlaps,
    reviewReady,
    openQuestions,
    presence: buildRoster(agents, now),
    staleClaims: detectStaleClaims(active, agents, now),
    communications: agents.map((agent) => {
      const endpoint = endpointsByAgent.get(agent.agentId);
      return {
        agentId: agent.agentId,
        promptable: endpointPromptable(endpoint, now),
        provider: endpoint?.provider ?? null,
        capabilities: effectiveEndpointCapabilities(endpoint, now),
      };
    }),
  };
}

/** Render the presence roster as indented lines, or a placeholder when empty. */
export function renderRosterLines(roster: readonly PresenceEntry[]): string[] {
  if (roster.length === 0) {
    return ['  none'];
  }
  return roster.map((entry) => {
    const state = `${entry.liveness}/${entry.status}`;
    const doing = entry.summary ?? '-';
    return `  ${entry.agentId.padEnd(18)} ${state.padEnd(20)} ${doing}  (${String(entry.ageSeconds)}s ago)`;
  });
}

export function renderStatusText(view: StatusView): string {
  const lines = ['Concord workspace', '', "Who's here"];
  lines.push(...renderRosterLines(view.presence));

  lines.push('', 'Live prompting');
  if (view.communications.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of view.communications) {
      lines.push(
        `  ${entry.agentId.padEnd(18)} ${entry.promptable ? 'promptable' : 'unreachable'}${entry.provider === null ? '' : ` via ${entry.provider}`}`,
      );
    }
  }

  lines.push('', 'Active work');
  if (view.active.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of view.active) {
      const parent = entry.parentTaskId === null ? '' : `  (child of ${entry.parentTaskId})`;
      lines.push(
        `  ${entry.taskId.padEnd(10)} ${entry.status.padEnd(16)} v${String(entry.version).padEnd(4)} ${(entry.agentId ?? entry.assignedAgentId ?? entry.agent).padEnd(18)} ${entry.branch.padEnd(20)} activity: ${entry.updatedAt}  touches: ${entry.touches}${parent}`,
      );
    }
  }

  lines.push('', 'Potential overlaps');
  if (view.overlaps.length === 0) {
    lines.push('  none');
  } else {
    for (const overlap of view.overlaps) {
      lines.push(`  ${overlap.a} <-> ${overlap.b}: ${overlap.reasons.join('; ')}`);
    }
  }

  lines.push('', 'Stale claims');
  if (view.staleClaims.length === 0) {
    lines.push('  none');
  } else {
    for (const claim of view.staleClaims) {
      const detail =
        claim.reason === 'agent-unregistered'
          ? 'agent never registered'
          : `agent away ${String(claim.ageSeconds ?? 0)}s`;
      lines.push(`  ${claim.taskId.padEnd(10)} ${claim.agentId} (${detail})`);
    }
  }

  lines.push('', 'Review ready');
  if (view.reviewReady.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of view.reviewReady) {
      lines.push(
        `  ${entry.taskId.padEnd(10)} tests: ${String(entry.testsCount)}  guardrails: ${String(entry.guardrailsCount)}  open questions: ${String(entry.openQuestionCount)}`,
      );
    }
  }

  lines.push('', 'Open questions');
  if (view.openQuestions.length === 0) {
    lines.push('  none');
  } else {
    for (const entry of view.openQuestions) {
      lines.push(`  ${entry.taskId}  "${entry.question}"`);
    }
  }

  return lines.join('\n');
}
