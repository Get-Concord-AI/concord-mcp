import type { AgentStatus } from '../db/index.js';
import type {
  FinishWorkInput,
  InspectWorkInput,
  StartWorkInput,
  TransferWorkInput,
  UpdateWorkInput,
} from './schemas.js';

type Require<T, Keys extends keyof T> = Omit<T, Keys> & {
  [Key in Keys]-?: NonNullable<T[Key]>;
};

export type RegisterAgentInput = Pick<
  StartWorkInput,
  'agent_id' | 'kind' | 'owner' | 'model' | 'summary' | 'branch' | 'worktree' | 'cwd' | 'pid'
> & { status?: AgentStatus | undefined };

export type ClaimWorkInput = Pick<
  StartWorkInput,
  | 'task_id'
  | 'title'
  | 'owner'
  | 'agent_id'
  | 'branch'
  | 'worktree'
  | 'parent_task_id'
  | 'expected_files'
  | 'modules'
  | 'domains'
  | 'risk_tags'
  | 'notes'
> & { agent?: string | undefined };

export interface GetTaskContextInput {
  task_id: NonNullable<InspectWorkInput['task_id']>;
}

export type UpdateTaskInput = Require<
  Pick<UpdateWorkInput, 'task_id' | 'kind' | 'content' | 'agent_id'>,
  'task_id' | 'kind'
> & { agent?: string | undefined };

type FinishEvidenceInput = Pick<
  FinishWorkInput,
  | 'task_id'
  | 'what_changed'
  | 'changed_files'
  | 'tests_run'
  | 'known_risks'
  | 'assumptions'
  | 'decisions'
  | 'guardrails_checked'
  | 'needs_review_from'
  | 'next_steps'
  | 'diff_size'
  | 'open_questions'
  | 'provenance'
>;

export type HandoffInput = FinishEvidenceInput & {
  status: string;
  ready_for_review?: boolean | undefined;
  agent_id?: string | undefined;
  expected_version?: number | undefined;
};

export type ReviewReadyInput = Pick<
  FinishWorkInput,
  | 'task_id'
  | 'tests_run'
  | 'diff_size'
  | 'guardrails_checked'
  | 'assumptions'
  | 'open_questions'
  | 'provenance'
> & {
  plan_summary: string;
  expected_version?: number | undefined;
};

type TransferActorInput = Pick<TransferWorkInput, 'task_id' | 'agent_id' | 'expected_version'>;

export type AssignTaskInput = Require<
  TransferActorInput & Pick<TransferWorkInput, 'to_agent_id' | 'lease_seconds' | 'reason'>,
  'to_agent_id'
>;

export type AcceptTaskInput = TransferActorInput;

export type ReleaseTaskInput = TransferActorInput & Pick<TransferWorkInput, 'reason'>;

export type ReassignTaskInput = Require<
  TransferActorInput &
    Pick<TransferWorkInput, 'to_agent_id' | 'lease_seconds' | 'reason' | 'force'>,
  'to_agent_id' | 'reason'
>;

export type CloseTaskInput = TransferActorInput & {
  reason: string;
  outcome?: Extract<FinishWorkInput['outcome'], 'complete' | 'closed'>;
};

export type ReopenTaskInput = Require<
  TransferActorInput & Pick<TransferWorkInput, 'reason'>,
  'reason'
>;

export type OfferHandoffInput = Require<
  TransferActorInput &
    Pick<
      TransferWorkInput,
      | 'to_agent_id'
      | 'what_changed'
      | 'changed_files'
      | 'tests_run'
      | 'known_risks'
      | 'assumptions'
      | 'decisions'
      | 'guardrails_checked'
      | 'next_steps'
      | 'expires_seconds'
    >,
  'to_agent_id' | 'what_changed'
>;

export type AcceptHandoffInput = Require<
  TransferActorInput & Pick<TransferWorkInput, 'handoff_id'>,
  'handoff_id'
>;

export type DeclineHandoffInput = Require<
  AcceptHandoffInput & Pick<TransferWorkInput, 'reason'>,
  'reason'
>;
