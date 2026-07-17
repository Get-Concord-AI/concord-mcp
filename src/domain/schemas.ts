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
