import { z } from 'zod';

/**
 * Row parsing lives here so the "never typecast" rule holds across the db layer:
 * every raw better-sqlite3 result enters as `unknown` and is narrowed by a Zod
 * schema into a typed, camelCased record. See CLAUDE.md.
 */

/** Lifecycle states a task can be in. */
export const taskStatusValues = [
  'proposed',
  'assigned',
  'active',
  'blocked',
  'handoff_offered',
  'handed_off',
  'review_ready',
  'complete',
  'closed',
] as const;
export type TaskStatus = (typeof taskStatusValues)[number];
const taskStatusSchema = z.enum(taskStatusValues);

/** Tools that can be recorded as events (used for adoption tracking). */
export const toolNameValues = [
  'claim_work',
  'update_task',
  'handoff',
  'review_ready',
  'assign_task',
  'accept_task',
  'release_task',
  'expire_assignment',
  'reassign_task',
  'offer_handoff',
  'accept_handoff',
  'decline_handoff',
  'expire_handoff',
  'close_task',
  'reopen_task',
] as const;
export type ToolName = (typeof toolNameValues)[number];
const toolNameSchema = z.enum(toolNameValues);

/** Outcome recorded for an event. */
export const eventStatusValues = ['success', 'error'] as const;
export type EventStatus = (typeof eventStatusValues)[number];
const eventStatusSchema = z.enum(eventStatusValues);

/** Parse a JSON-encoded TEXT column into a validated `string[]`. */
export function parseStringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return z.array(z.string()).parse(parsed);
}

/** Serialize a `string[]` for storage in a TEXT column. */
export function serializeStringArray(values: readonly string[]): string {
  return JSON.stringify(values);
}

/** A single provenance entry: which field came from which source. */
export interface ProvenanceEntry {
  field: string;
  source: string;
}

const provenanceSchema = z.array(z.object({ field: z.string(), source: z.string() }));

/** Parse a JSON-encoded TEXT column into validated provenance entries. */
export function parseProvenance(json: string): ProvenanceEntry[] {
  const parsed: unknown = JSON.parse(json);
  return provenanceSchema.parse(parsed);
}

/** Serialize provenance entries for storage in a TEXT column. */
export function serializeProvenance(entries: readonly ProvenanceEntry[]): string {
  return JSON.stringify(entries);
}

// --- tasks -----------------------------------------------------------------

export interface TaskRecord {
  taskId: string;
  title: string;
  owner: string | null;
  agent: string | null;
  branch: string | null;
  worktree: string | null;
  expectedFiles: string[];
  modules: string[];
  domains: string[];
  riskTags: string[];
  notes: string | null;
  status: TaskStatus;
  /** The parent task this is a subtask of, or null for a top-level task. */
  parentTaskId: string | null;
  /** The agent instance identity that claimed this, or null.
   * Distinct from `agent` (the kind string): used to check the claimant's
   * liveness for stale-claim detection. */
  agentId: string | null;
  /** Monotonic compare-and-swap version for lifecycle transitions. */
  version: number;
  /** Agent offered this task but not yet the active owner. */
  assignedAgentId: string | null;
  /** Optional assignment/ownership lease deadline. */
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const taskDbRowSchema = z.object({
  task_id: z.string(),
  title: z.string(),
  owner: z.string().nullable(),
  agent: z.string().nullable(),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  expected_files: z.string(),
  modules: z.string(),
  domains: z.string(),
  risk_tags: z.string(),
  notes: z.string().nullable(),
  status: taskStatusSchema,
  parent_task_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  version: z.number().int().positive(),
  assigned_agent_id: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function parseTaskRow(raw: unknown): TaskRecord {
  const row = taskDbRowSchema.parse(raw);
  return {
    taskId: row.task_id,
    title: row.title,
    owner: row.owner,
    agent: row.agent,
    branch: row.branch,
    worktree: row.worktree,
    expectedFiles: parseStringArray(row.expected_files),
    modules: parseStringArray(row.modules),
    domains: parseStringArray(row.domains),
    riskTags: parseStringArray(row.risk_tags),
    notes: row.notes,
    status: row.status,
    parentTaskId: row.parent_task_id,
    agentId: row.agent_id,
    version: row.version,
    assignedAgentId: row.assigned_agent_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- task updates -----------------------------------------------------------

export const taskUpdateKindValues = [
  'intent',
  'progress',
  'assumption',
  'decision',
  'question',
  'answer',
  'blocker',
  'finding',
] as const;
export type TaskUpdateKind = (typeof taskUpdateKindValues)[number];
const taskUpdateKindSchema = z.enum(taskUpdateKindValues);

export interface TaskUpdateRecord {
  id: number;
  taskId: string;
  kind: TaskUpdateKind;
  content: string;
  agent: string | null;
  createdAt: string;
}

const taskUpdateDbRowSchema = z.object({
  id: z.number().int(),
  task_id: z.string(),
  kind: taskUpdateKindSchema,
  content: z.string(),
  agent: z.string().nullable(),
  created_at: z.string(),
});

export function parseTaskUpdateRow(raw: unknown): TaskUpdateRecord {
  const row = taskUpdateDbRowSchema.parse(raw);
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    content: row.content,
    agent: row.agent,
    createdAt: row.created_at,
  };
}

// --- handoffs --------------------------------------------------------------

export interface HandoffRecord {
  id: number;
  taskId: string;
  status: string;
  changedFiles: string[];
  whatChanged: string;
  testsRun: string[];
  knownRisks: string[];
  assumptions: string[];
  decisions: string[];
  guardrailsChecked: string[];
  needsReviewFrom: string[];
  nextSteps: string[];
  fromAgentId: string | null;
  toAgentId: string | null;
  deliveryStatus: HandoffDeliveryStatus;
  expiresAt: string | null;
  resolvedAt: string | null;
  taskVersion: number | null;
  resolutionReason: string | null;
  createdAt: string;
}

export const handoffDeliveryStatusValues = [
  'recorded',
  'pending',
  'accepted',
  'declined',
  'expired',
] as const;
export type HandoffDeliveryStatus = (typeof handoffDeliveryStatusValues)[number];
const handoffDeliveryStatusSchema = z.enum(handoffDeliveryStatusValues);

const handoffDbRowSchema = z.object({
  id: z.number().int(),
  task_id: z.string(),
  status: z.string(),
  changed_files: z.string(),
  what_changed: z.string(),
  tests_run: z.string(),
  known_risks: z.string(),
  assumptions: z.string(),
  decisions: z.string(),
  guardrails_checked: z.string(),
  needs_review_from: z.string(),
  next_steps: z.string(),
  from_agent_id: z.string().nullable(),
  to_agent_id: z.string().nullable(),
  delivery_status: handoffDeliveryStatusSchema,
  expires_at: z.string().nullable(),
  resolved_at: z.string().nullable(),
  task_version: z.number().int().nullable(),
  resolution_reason: z.string().nullable(),
  created_at: z.string(),
});

export function parseHandoffRow(raw: unknown): HandoffRecord {
  const row = handoffDbRowSchema.parse(raw);
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    changedFiles: parseStringArray(row.changed_files),
    whatChanged: row.what_changed,
    testsRun: parseStringArray(row.tests_run),
    knownRisks: parseStringArray(row.known_risks),
    assumptions: parseStringArray(row.assumptions),
    decisions: parseStringArray(row.decisions),
    guardrailsChecked: parseStringArray(row.guardrails_checked),
    needsReviewFrom: parseStringArray(row.needs_review_from),
    nextSteps: parseStringArray(row.next_steps),
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    deliveryStatus: row.delivery_status,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    taskVersion: row.task_version,
    resolutionReason: row.resolution_reason,
    createdAt: row.created_at,
  };
}

// --- ownership events -------------------------------------------------------

export interface OwnershipEventRecord {
  id: number;
  taskId: string;
  transition: string;
  actorAgentId: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  fromVersion: number;
  toVersion: number;
  reason: string | null;
  createdAt: string;
}

const ownershipEventDbRowSchema = z.object({
  id: z.number().int(),
  task_id: z.string(),
  transition: z.string(),
  actor_agent_id: z.string(),
  from_agent_id: z.string().nullable(),
  to_agent_id: z.string().nullable(),
  from_status: taskStatusSchema,
  to_status: taskStatusSchema,
  from_version: z.number().int().positive(),
  to_version: z.number().int().positive(),
  reason: z.string().nullable(),
  created_at: z.string(),
});

export function parseOwnershipEventRow(raw: unknown): OwnershipEventRecord {
  const row = ownershipEventDbRowSchema.parse(raw);
  return {
    id: row.id,
    taskId: row.task_id,
    transition: row.transition,
    actorAgentId: row.actor_agent_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

// --- reviews ---------------------------------------------------------------

export interface ReviewRecord {
  id: number;
  taskId: string;
  planSummary: string;
  testsRun: string[];
  diffSize: string | null;
  guardrailsChecked: string[];
  assumptions: string[];
  openQuestions: string[];
  provenance: ProvenanceEntry[];
  createdAt: string;
}

const reviewDbRowSchema = z.object({
  id: z.number().int(),
  task_id: z.string(),
  plan_summary: z.string(),
  tests_run: z.string(),
  diff_size: z.string().nullable(),
  guardrails_checked: z.string(),
  assumptions: z.string(),
  open_questions: z.string(),
  provenance: z.string(),
  created_at: z.string(),
});

export function parseReviewRow(raw: unknown): ReviewRecord {
  const row = reviewDbRowSchema.parse(raw);
  return {
    id: row.id,
    taskId: row.task_id,
    planSummary: row.plan_summary,
    testsRun: parseStringArray(row.tests_run),
    diffSize: row.diff_size,
    guardrailsChecked: parseStringArray(row.guardrails_checked),
    assumptions: parseStringArray(row.assumptions),
    openQuestions: parseStringArray(row.open_questions),
    provenance: parseProvenance(row.provenance),
    createdAt: row.created_at,
  };
}

// --- events ----------------------------------------------------------------

export interface EventRecord {
  id: number;
  taskId: string | null;
  tool: ToolName;
  status: EventStatus;
  detail: string | null;
  createdAt: string;
}

const eventDbRowSchema = z.object({
  id: z.number().int(),
  task_id: z.string().nullable(),
  tool: toolNameSchema,
  status: eventStatusSchema,
  detail: z.string().nullable(),
  created_at: z.string(),
});

export function parseEventRow(raw: unknown): EventRecord {
  const row = eventDbRowSchema.parse(raw);
  return {
    id: row.id,
    taskId: row.task_id,
    tool: row.tool,
    status: row.status,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

// --- agents ----------------------------------------------------------------

/** Status an agent reports about its own work. Liveness (live/idle/away) is
 * derived separately from `last_seen` in `domain/presence.ts`. */
export const agentStatusValues = ['active', 'blocked', 'waiting_review', 'done'] as const;
export type AgentStatus = (typeof agentStatusValues)[number];
const agentStatusSchema = z.enum(agentStatusValues);

/** A registered agent instance. `agentId` is a distinct per-session identity
 * (e.g. `claude-code:7p8v`), unlike the `agent` *kind* string on a task. */
export interface AgentRecord {
  agentId: string;
  kind: string;
  owner: string | null;
  model: string | null;
  pid: number | null;
  cwd: string | null;
  worktree: string | null;
  branch: string | null;
  summary: string | null;
  status: AgentStatus;
  firstSeen: string;
  lastSeen: string;
}

const agentDbRowSchema = z.object({
  agent_id: z.string(),
  kind: z.string(),
  owner: z.string().nullable(),
  model: z.string().nullable(),
  pid: z.number().int().nullable(),
  cwd: z.string().nullable(),
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  summary: z.string().nullable(),
  status: agentStatusSchema,
  first_seen: z.string(),
  last_seen: z.string(),
});

export function parseAgentRow(raw: unknown): AgentRecord {
  const row = agentDbRowSchema.parse(raw);
  return {
    agentId: row.agent_id,
    kind: row.kind,
    owner: row.owner,
    model: row.model,
    pid: row.pid,
    cwd: row.cwd,
    worktree: row.worktree,
    branch: row.branch,
    summary: row.summary,
    status: row.status,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

// --- agent communication ---------------------------------------------------

export const agentEndpointStatusValues = ['connected', 'disconnected'] as const;
export type AgentEndpointStatus = (typeof agentEndpointStatusValues)[number];
const agentEndpointStatusSchema = z.enum(agentEndpointStatusValues);

export interface AgentEndpointRecord {
  endpointId: string;
  agentId: string;
  provider: string;
  transport: string;
  capabilities: string[];
  address: string;
  credentialHash: string;
  status: AgentEndpointStatus;
  lastSeen: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const agentEndpointDbRowSchema = z.object({
  endpoint_id: z.string(),
  agent_id: z.string(),
  provider: z.string(),
  transport: z.string(),
  capabilities: z.string(),
  address: z.string(),
  credential_hash: z.string(),
  status: agentEndpointStatusSchema,
  last_seen: z.string(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function parseAgentEndpointRow(raw: unknown): AgentEndpointRecord {
  const row = agentEndpointDbRowSchema.parse(raw);
  return {
    endpointId: row.endpoint_id,
    agentId: row.agent_id,
    provider: row.provider,
    transport: row.transport,
    capabilities: parseStringArray(row.capabilities),
    address: row.address,
    credentialHash: row.credential_hash,
    status: row.status,
    lastSeen: row.last_seen,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const agentMessageStatusValues = ['pending', 'delivered', 'replied', 'failed'] as const;
export type AgentMessageStatus = (typeof agentMessageStatusValues)[number];
const agentMessageStatusSchema = z.enum(agentMessageStatusValues);

export const agentMessageErrorCodeValues = [
  'target_unreachable',
  'target_not_promptable',
  'capability_unavailable',
  'unauthorized',
  'delivery_timeout',
] as const;
export type AgentMessageErrorCode = (typeof agentMessageErrorCodeValues)[number];
const agentMessageErrorCodeSchema = z.enum(agentMessageErrorCodeValues);

export interface AgentMessageRecord {
  messageId: string;
  taskId: string | null;
  senderAgentId: string;
  recipientAgentId: string;
  replyToMessageId: string | null;
  content: string;
  deliveryMode: 'steer';
  status: AgentMessageStatus;
  provider: string | null;
  providerReceipt: string | null;
  errorCode: AgentMessageErrorCode | null;
  errorDetail: string | null;
  idempotencyKey: string;
  createdAt: string;
  deliveredAt: string | null;
  repliedAt: string | null;
  failedAt: string | null;
}

const agentMessageDbRowSchema = z.object({
  message_id: z.string(),
  task_id: z.string().nullable(),
  sender_agent_id: z.string(),
  recipient_agent_id: z.string(),
  reply_to_message_id: z.string().nullable(),
  content: z.string(),
  delivery_mode: z.literal('steer'),
  status: agentMessageStatusSchema,
  provider: z.string().nullable(),
  provider_receipt: z.string().nullable(),
  error_code: agentMessageErrorCodeSchema.nullable(),
  error_detail: z.string().nullable(),
  idempotency_key: z.string(),
  created_at: z.string(),
  delivered_at: z.string().nullable(),
  replied_at: z.string().nullable(),
  failed_at: z.string().nullable(),
});

export function parseAgentMessageRow(raw: unknown): AgentMessageRecord {
  const row = agentMessageDbRowSchema.parse(raw);
  return {
    messageId: row.message_id,
    taskId: row.task_id,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    replyToMessageId: row.reply_to_message_id,
    content: row.content,
    deliveryMode: row.delivery_mode,
    status: row.status,
    provider: row.provider,
    providerReceipt: row.provider_receipt,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    repliedAt: row.replied_at,
    failedAt: row.failed_at,
  };
}

export const agentMessageEventValues = ['accepted', 'delivered', 'replied', 'failed'] as const;
export type AgentMessageEvent = (typeof agentMessageEventValues)[number];
const agentMessageEventSchema = z.enum(agentMessageEventValues);

export interface AgentMessageEventRecord {
  id: number;
  messageId: string;
  event: AgentMessageEvent;
  detail: string | null;
  createdAt: string;
}

const agentMessageEventDbRowSchema = z.object({
  id: z.number().int(),
  message_id: z.string(),
  event: agentMessageEventSchema,
  detail: z.string().nullable(),
  created_at: z.string(),
});

export function parseAgentMessageEventRow(raw: unknown): AgentMessageEventRecord {
  const row = agentMessageEventDbRowSchema.parse(raw);
  return {
    id: row.id,
    messageId: row.message_id,
    event: row.event,
    detail: row.detail,
    createdAt: row.created_at,
  };
}
