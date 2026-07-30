import { z } from 'zod';

/**
 * The five public MCP workflow contracts. Internal lifecycle operations derive
 * their TypeScript inputs from these shapes in operations.ts; they are not
 * separate externally validated tools.
 */

const taskIdField = z.string().min(1).describe('Stable task identifier, e.g. TASK-12');

const agentIdField = z
  .string()
  .optional()
  .describe('Existing agent identity to refresh; omit on the first call to generate one');

const actorAgentIdField = z
  .string()
  .min(1)
  .describe('Registered agent identity performing this operation');

const taskVersionField = z
  .number()
  .int()
  .positive()
  .describe('Task version last read by the caller; stale versions are rejected');

const workspaceIdField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Workspace id returned by a Concord operation. Omit to use the automatically resolved repository workspace.',
  );

const evidenceInputShape = {
  what_changed: z.string().min(1).describe('Concise summary of what changed'),
  changed_files: z.array(z.string()).optional().describe('Files that changed'),
  tests_run: z.array(z.string()).optional().describe('Test commands run'),
  known_risks: z.array(z.string()).optional().describe('Known risks introduced'),
  assumptions: z.array(z.string()).optional().describe('Assumptions made'),
  decisions: z.array(z.string()).optional().describe('Notable decisions and why'),
  guardrails_checked: z.array(z.string()).optional().describe('Guardrails checked'),
  next_steps: z.array(z.string()).optional().describe('Remaining work or follow-ups'),
} as const;

const provenanceField = z
  .array(z.object({ field: z.string(), source: z.string() }))
  .optional()
  .describe('Evidence source for review claims');

export const startWorkInputShape = {
  task_id: taskIdField,
  title: z.string().min(1).describe('Short human-readable title'),
  kind: z.string().min(1).describe('Agent type or provider, e.g. claude-code or codex'),
  agent_id: agentIdField,
  owner: z.string().optional().describe('Human accountable for this agent and task'),
  model: z.string().optional().describe('Model the agent is running'),
  summary: z.string().optional().describe('One-line description of the current work'),
  branch: z.string().optional().describe('Git branch, if known'),
  worktree: z.string().optional().describe('Git worktree path, if used'),
  cwd: z.string().optional().describe('Agent working directory'),
  pid: z.number().int().optional().describe('Agent process id, if known'),
  parent_task_id: z.string().optional().describe('Parent task for a smaller claimed unit'),
  expected_files: z.array(z.string()).optional().describe('Files expected to change'),
  modules: z.array(z.string()).optional().describe('Logical modules touched'),
  domains: z.array(z.string()).optional().describe('Product domains touched'),
  risk_tags: z.array(z.string()).optional().describe('Risk tags shared with related work'),
  notes: z.string().optional().describe('Concise task notes'),
  workspace_id: workspaceIdField,
} as const;
export type StartWorkInput = z.infer<z.ZodObject<typeof startWorkInputShape>>;

export const inspectWorkInputShape = {
  task_id: taskIdField.optional().describe('Task to inspect; omit for the whole workspace state'),
  workspace_id: workspaceIdField,
} as const;
export type InspectWorkInput = z.infer<z.ZodObject<typeof inspectWorkInputShape>>;

export const updateWorkInputShape = {
  task_id: taskIdField,
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
    .describe('Kind of task-scoped update'),
  content: z.string().min(1).describe('Concise context another agent needs'),
  agent_id: agentIdField,
  workspace_id: workspaceIdField,
} as const;
export type UpdateWorkInput = z.infer<z.ZodObject<typeof updateWorkInputShape>>;

const transferWorkActionValues = [
  'assign',
  'accept',
  'decline',
  'release',
  'reassign',
  'offer',
  'reopen',
] as const;

export const transferWorkInputShape = {
  task_id: taskIdField,
  action: z
    .enum(transferWorkActionValues)
    .describe('Ownership action to apply through the versioned task state machine'),
  agent_id: actorAgentIdField,
  expected_version: taskVersionField,
  to_agent_id: z.string().min(1).optional().describe('Required for assign, reassign, and offer'),
  handoff_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Pending handoff to resolve; inferred from the task when omitted'),
  lease_seconds: z.number().int().positive().optional(),
  expires_seconds: z.number().int().positive().optional(),
  force: z.boolean().optional(),
  reason: z.string().min(1).optional(),
  what_changed: evidenceInputShape.what_changed.optional().describe('Required for offer'),
  changed_files: evidenceInputShape.changed_files,
  tests_run: evidenceInputShape.tests_run,
  known_risks: evidenceInputShape.known_risks,
  assumptions: evidenceInputShape.assumptions,
  decisions: evidenceInputShape.decisions,
  guardrails_checked: evidenceInputShape.guardrails_checked,
  next_steps: evidenceInputShape.next_steps,
  workspace_id: workspaceIdField,
} as const;
export type TransferWorkInput = z.infer<z.ZodObject<typeof transferWorkInputShape>>;

export const finishWorkInputShape = {
  task_id: taskIdField,
  agent_id: actorAgentIdField,
  expected_version: taskVersionField,
  outcome: z
    .enum(['handoff', 'review_ready', 'complete', 'closed'])
    .default('complete')
    .describe('Final task state; handoff records evidence without changing lifecycle state'),
  ...evidenceInputShape,
  needs_review_from: z.array(z.string()).optional().describe('Who should review'),
  diff_size: z.string().optional().describe('Rough diff size, e.g. +120 / -30'),
  open_questions: z.array(z.string()).optional().describe('Unresolved review questions'),
  provenance: provenanceField,
  reason: z
    .string()
    .min(1)
    .optional()
    .describe('Audited terminal reason; defaults to the change summary'),
  workspace_id: workspaceIdField,
} as const;
export type FinishWorkInput = z.infer<z.ZodObject<typeof finishWorkInputShape>>;
