import { z } from 'zod';

/**
 * Zod input schemas for the MCP tools. Each tool exposes its schema as a raw
 * shape (the form `McpServer.registerTool` expects) plus an inferred input type.
 * Fields use snake_case to match the tool's public JSON contract.
 */

export const claimWorkInputShape = {
  task_id: z.string().min(1).describe('Stable identifier for the task, e.g. TASK-12'),
  title: z.string().min(1).describe('Short human-readable title'),
  owner: z.string().optional().describe('Person accountable for the task'),
  agent: z.string().optional().describe('Agent doing the work, e.g. claude-code'),
  branch: z.string().optional().describe('Git branch, if known'),
  worktree: z.string().optional().describe('Git worktree path, if used'),
  expected_files: z.array(z.string()).optional().describe('Files the task expects to touch'),
  modules: z.array(z.string()).optional().describe('Logical modules touched, e.g. billing'),
  domains: z.array(z.string()).optional().describe('Product domains touched, e.g. payments'),
  risk_tags: z.array(z.string()).optional().describe('Risk tags, e.g. payment-flow'),
  notes: z.string().optional().describe('Freeform notes'),
} as const;

export const claimWorkInputSchema = z.object(claimWorkInputShape);
export type ClaimWorkInput = z.infer<typeof claimWorkInputSchema>;

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
