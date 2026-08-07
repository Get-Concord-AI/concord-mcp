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

const serializedToolParameterPattern = /<\/\s*(?:summary|notes)\s*>|<\s*parameter\s+name\s*=/i;

/**
 * Some clients can accidentally serialize later tool arguments into an
 * earlier free-text field. Accepting that payload would create a claim without
 * its real expected_files/modules/domains and silently weaken overlap checks.
 * Reject the recognizable serialization markers so the client retries with
 * each argument in its proper top-level field.
 */
function claimMetadataField(description: string) {
  return z
    .string()
    .refine((value) => !serializedToolParameterPattern.test(value), {
      message:
        'Serialized tool parameter markup is not allowed; pass expected_files, notes, and other arguments as separate top-level fields.',
    })
    .describe(description);
}

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
  title: claimMetadataField('Short human-readable title').min(1),
  kind: claimMetadataField('Agent type or provider, e.g. claude-code or codex').min(1),
  agent_id: agentIdField,
  owner: claimMetadataField('Human accountable for this agent and task').optional(),
  model: claimMetadataField('Model the agent is running').optional(),
  summary: claimMetadataField('One-line description of the current work').optional(),
  branch: claimMetadataField('Git branch, if known').optional(),
  worktree: claimMetadataField('Git worktree path, if used').optional(),
  cwd: claimMetadataField('Agent working directory').optional(),
  pid: z.number().int().optional().describe('Agent process id, if known'),
  parent_task_id: claimMetadataField('Parent task for a smaller claimed unit').optional(),
  expected_files: z.array(z.string()).optional().describe('Files expected to change'),
  modules: z.array(z.string()).optional().describe('Logical modules touched'),
  domains: z.array(z.string()).optional().describe('Product domains touched'),
  risk_tags: z.array(z.string()).optional().describe('Risk tags shared with related work'),
  notes: claimMetadataField('Concise task notes').optional(),
  workspace_id: workspaceIdField,
} as const;
export type StartWorkInput = z.infer<z.ZodObject<typeof startWorkInputShape>>;

export const inspectWorkInputShape = {
  task_id: taskIdField.optional().describe('Task to inspect; omit for the whole workspace state'),
  agent_id: z.string().min(1).optional().describe('Agent communication inbox/outbox to inspect'),
  message_id: z.string().min(1).optional().describe('Prompt/reply thread to inspect'),
  workspace_id: workspaceIdField,
} as const;
export type InspectWorkInput = z.infer<z.ZodObject<typeof inspectWorkInputShape>>;

export const updateWorkInputShape = {
  operation: z
    .enum(['record', 'prompt', 'reply'])
    .optional()
    .describe('Defaults to record; prompt and reply deliver live inter-agent messages'),
  task_id: taskIdField.optional().describe('Required for record; optional context for prompts'),
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
    .optional()
    .describe('Kind of task-scoped update'),
  content: z.string().min(1).max(16_384).describe('Concise context another agent needs'),
  agent_id: agentIdField,
  to_agent_id: z.string().min(1).optional().describe('Recipient required for prompt'),
  reply_to_message_id: z.string().min(1).optional().describe('Message being answered for reply'),
  idempotency_key: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Required for prompt and reply; makes delivery safe to retry'),
  delivery_mode: z
    .literal('steer')
    .optional()
    .describe('Live delivery mode; steer is the only mode in v1'),
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
