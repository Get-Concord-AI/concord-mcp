import { z } from 'zod';

import { agentStatusValues } from '../db/rows.js';

/**
 * Zod input schemas for the MCP tools. Each tool exposes its schema as a raw
 * shape (the form `McpServer.registerTool` expects) plus an inferred input type.
 * Fields use snake_case to match the tool's public JSON contract.
 */

/** Optional instance identity carried by every write so it refreshes presence.
 * Distinct from the `agent` *kind* string — this identifies one running
 * instance (e.g. `claude-code:7p8v`), obtained from `register_agent`. */
const agentIdField = z
  .string()
  .optional()
  .describe(
    'Identity of the registered agent instance doing this work, e.g. claude-code:7p8v. ' +
      "Supplying it refreshes the agent's presence (liveness) in the roster.",
  );

export const registerAgentInputShape = {
  agent_id: z
    .string()
    .optional()
    .describe(
      'Stable per-session identity for this agent instance, e.g. claude-code:7p8v. Omit on the ' +
        'first call to have one generated, then reuse the returned id on every later call so ' +
        'presence stays attributed to the same instance.',
    ),
  kind: z.string().min(1).describe('Agent type / provider, e.g. claude-code, codex, cursor'),
  owner: z.string().optional().describe('Human accountable for this agent'),
  model: z.string().optional().describe('Model the agent is running, e.g. opus-4.8'),
  summary: z.string().optional().describe('One line: what this agent is working on right now'),
  status: z
    .enum(agentStatusValues)
    .optional()
    .describe('Reported status: active, blocked, waiting_review, or done (default active)'),
  branch: z.string().optional().describe('Git branch, if known'),
  worktree: z.string().optional().describe('Git worktree path, if used'),
  cwd: z.string().optional().describe('Working directory, for disambiguating instances'),
  pid: z.number().int().optional().describe('Process id, for disambiguating instances'),
} as const;

export const registerAgentInputSchema = z.object(registerAgentInputShape);
export type RegisterAgentInput = z.infer<typeof registerAgentInputSchema>;

export const claimWorkInputShape = {
  task_id: z.string().min(1).describe('Stable identifier for the task, e.g. TASK-12'),
  title: z.string().min(1).describe('Short human-readable title'),
  owner: z.string().optional().describe('Person or team accountable for the task (optional)'),
  agent: z
    .string()
    .optional()
    .describe(
      'Stable identifier for the agent doing the work, e.g. claude-code or codex. Keep it ' +
        'consistent across a session so the same agent is not recorded under different names.',
    ),
  branch: z.string().optional().describe('Git branch, if known'),
  worktree: z.string().optional().describe('Git worktree path, if used'),
  parent_task_id: z
    .string()
    .optional()
    .describe(
      'Parent task id when this is a subtask of a larger effort, e.g. TODO-FRONTEND-001.1 ' +
        'is a subtask of TODO-FRONTEND-001. Overlaps between a parent and its own child are ' +
        'not flagged.',
    ),
  expected_files: z.array(z.string()).optional().describe('Files the task expects to touch'),
  modules: z.array(z.string()).optional().describe('Logical modules touched, e.g. billing'),
  domains: z.array(z.string()).optional().describe('Product domains touched, e.g. payments'),
  risk_tags: z.array(z.string()).optional().describe('Risk tags, e.g. payment-flow'),
  notes: z.string().optional().describe('Freeform notes'),
  agent_id: agentIdField,
} as const;

export const claimWorkInputSchema = z.object(claimWorkInputShape);
export type ClaimWorkInput = z.infer<typeof claimWorkInputSchema>;

export const updateTaskInputShape = {
  task_id: z.string().min(1).describe('Claimed task receiving this memory entry'),
  kind: z
    .enum([
      'intent',
      'progress',
      'assumption',
      'decision',
      'question',
      'answer',
      'blocker',
      'finding',
    ])
    .describe('The kind of task-scoped update'),
  content: z.string().min(1).describe('Concise context another agent needs'),
  agent: z.string().optional().describe('Agent recording the update; defaults to the claimant'),
  agent_id: agentIdField,
} as const;

export const updateTaskInputSchema = z.object(updateTaskInputShape);
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const getTaskContextInputShape = {
  task_id: z.string().min(1).describe('Task whose shared context should be read'),
} as const;

export const getTaskContextInputSchema = z.object(getTaskContextInputShape);
export type GetTaskContextInput = z.infer<typeof getTaskContextInputSchema>;

export const handoffInputShape = {
  task_id: z.string().min(1).describe('The task being handed off, e.g. TASK-12'),
  status: z.string().min(1).describe('Handoff status, e.g. done, blocked, in_progress'),
  what_changed: z.string().min(1).describe('Concise summary of what changed'),
  changed_files: z.array(z.string()).optional().describe('Files that changed'),
  tests_run: z.array(z.string()).optional().describe('Test commands run'),
  known_risks: z.array(z.string()).optional().describe('Known risks introduced'),
  assumptions: z.array(z.string()).optional().describe('Assumptions the agent made'),
  decisions: z.array(z.string()).optional().describe('Notable decisions and why'),
  guardrails_checked: z.array(z.string()).optional().describe('Guardrails manually checked'),
  needs_review_from: z.array(z.string()).optional().describe('Who should review'),
  next_steps: z.array(z.string()).optional().describe('Remaining work or follow-ups'),
  ready_for_review: z
    .boolean()
    .optional()
    .describe(
      'Set true when this handoff also marks the task ready for review (before a PR). ' +
        'This renders REVIEW_PACKET.md from the handoff.',
    ),
  diff_size: z
    .string()
    .optional()
    .describe('Rough diff size for the review packet, e.g. "+120 / -30"'),
  open_questions: z.array(z.string()).optional().describe('Unresolved questions for the reviewer'),
  provenance: z
    .array(z.object({ field: z.string(), source: z.string() }))
    .optional()
    .describe('Where each claim came from, e.g. { field: "tests", source: "command output" }'),
  agent_id: agentIdField,
} as const;

export const handoffInputSchema = z.object(handoffInputShape);
export type HandoffInput = z.infer<typeof handoffInputSchema>;

export const reviewReadyInputShape = {
  task_id: z.string().min(1).describe('The task being marked review-ready'),
  plan_summary: z.string().min(1).describe('What the change intended to do'),
  tests_run: z.array(z.string()).optional().describe('Test commands run'),
  diff_size: z.string().optional().describe('Rough diff size, e.g. "+120 / -30"'),
  guardrails_checked: z.array(z.string()).optional().describe('Guardrails checked'),
  assumptions: z.array(z.string()).optional().describe('Assumptions made'),
  open_questions: z.array(z.string()).optional().describe('Unresolved questions for review'),
  provenance: z
    .array(z.object({ field: z.string(), source: z.string() }))
    .optional()
    .describe('Where each claim came from, e.g. { field: "tests", source: "command output" }'),
} as const;

export const reviewReadyInputSchema = z.object(reviewReadyInputShape);
export type ReviewReadyInput = z.infer<typeof reviewReadyInputSchema>;
