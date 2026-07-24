import { z } from 'zod';

/**
 * Row parsing lives here so the "never typecast" rule holds across the db layer:
 * every raw better-sqlite3 result enters as `unknown` and is narrowed by a Zod
 * schema into a typed, camelCased record. See CLAUDE.md.
 */

/** Lifecycle states a task can be in. */
export const taskStatusValues = ['active', 'handed_off', 'review_ready'] as const;
export type TaskStatus = (typeof taskStatusValues)[number];
const taskStatusSchema = z.enum(taskStatusValues);

/** Tools that can be recorded as events (used for adoption tracking). */
export const toolNameValues = ['claim_work', 'update_task', 'handoff', 'review_ready'] as const;
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
  /** The agent instance (register_agent identity) that claimed this, or null.
   * Distinct from `agent` (the kind string): used to check the claimant's
   * liveness for stale-claim detection. */
  agentId: string | null;
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
  createdAt: string;
}

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
