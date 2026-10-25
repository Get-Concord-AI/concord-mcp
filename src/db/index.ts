import { openDatabase, type ConcordDatabase } from './connection.js';
import { LOCAL_PROJECT } from './project-scope-migration.js';
import {
  createAgentEndpointRepository,
  type AgentEndpointRepository,
} from './repositories/agent-endpoints.js';
import {
  createAgentMessageRepository,
  type AgentMessageRepository,
} from './repositories/agent-messages.js';
import { createAgentRepository, type AgentRepository } from './repositories/agents.js';
import { createEventRepository, type EventRepository } from './repositories/events.js';
import { createHandoffRepository, type HandoffRepository } from './repositories/handoffs.js';
import {
  createOwnershipEventRepository,
  type OwnershipEventRepository,
} from './repositories/ownership-events.js';
import { createReviewRepository, type ReviewRepository } from './repositories/reviews.js';
import {
  createTaskUpdateRepository,
  type TaskUpdateRepository,
} from './repositories/task-updates.js';
import { createTaskRepository, type TaskRepository } from './repositories/tasks.js';

export type { ConcordDatabase } from './connection.js';
export { openDatabase } from './connection.js';
export { LOCAL_PROJECT } from './project-scope-migration.js';
export type { NewTask, TaskRepository } from './repositories/tasks.js';
export { createTaskRepository } from './repositories/tasks.js';
export type { NewHandoff, HandoffRepository } from './repositories/handoffs.js';
export type { NewReview, ReviewRepository } from './repositories/reviews.js';
export type { NewTaskUpdate, TaskUpdateRepository } from './repositories/task-updates.js';
export type { NewEvent, EventRepository } from './repositories/events.js';
export type {
  NewOwnershipEvent,
  OwnershipEventRepository,
} from './repositories/ownership-events.js';
export type { NewAgent, AgentRepository } from './repositories/agents.js';
export type { NewAgentEndpoint, AgentEndpointRepository } from './repositories/agent-endpoints.js';
export type {
  ClaimOptions,
  NewAgentMessage,
  AgentMessageRepository,
} from './repositories/agent-messages.js';
export type {
  TaskRecord,
  TaskStatus,
  HandoffRecord,
  ReviewRecord,
  ProvenanceEntry,
  EventRecord,
  EventStatus,
  ToolName,
  TaskUpdateKind,
  TaskUpdateRecord,
  AgentRecord,
  AgentStatus,
  OwnershipEventRecord,
  HandoffDeliveryStatus,
  AgentEndpointRecord,
  AgentEndpointStatus,
  AgentMessageRecord,
  AgentMessageStatus,
  AgentMessageErrorCode,
  AgentMessageEventRecord,
} from './rows.js';

/** The full set of Concord repositories bound to one database. */
export interface Repositories {
  db: ConcordDatabase;
  /** The project task-scoped repositories see. */
  project: string;
  tasks: TaskRepository;
  handoffs: HandoffRepository;
  reviews: ReviewRepository;
  taskUpdates: TaskUpdateRepository;
  events: EventRepository;
  agents: AgentRepository;
  agentEndpoints: AgentEndpointRepository;
  agentMessages: AgentMessageRepository;
  ownershipEvents: OwnershipEventRepository;
}

/** Bind all repositories to an open database; task-scoped ones see only `project`. */
export function createRepositories(
  db: ConcordDatabase,
  project: string = LOCAL_PROJECT,
): Repositories {
  return {
    db,
    project,
    tasks: createTaskRepository(db, project),
    handoffs: createHandoffRepository(db, project),
    reviews: createReviewRepository(db, project),
    taskUpdates: createTaskUpdateRepository(db, project),
    events: createEventRepository(db, project),
    agents: createAgentRepository(db),
    agentEndpoints: createAgentEndpointRepository(db),
    agentMessages: createAgentMessageRepository(db, project),
    ownershipEvents: createOwnershipEventRepository(db, project),
  };
}

/** Open the database at `filename` and bind all repositories to `project`. */
export function openRepositories(filename: string, project: string = LOCAL_PROJECT): Repositories {
  return createRepositories(openDatabase(filename), project);
}
