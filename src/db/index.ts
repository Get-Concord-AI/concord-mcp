import { openDatabase, type ConcordDatabase } from './connection.js';
import { createAgentRepository, type AgentRepository } from './repositories/agents.js';
import { createEventRepository, type EventRepository } from './repositories/events.js';
import { createHandoffRepository, type HandoffRepository } from './repositories/handoffs.js';
import { createReviewRepository, type ReviewRepository } from './repositories/reviews.js';
import {
  createTaskUpdateRepository,
  type TaskUpdateRepository,
} from './repositories/task-updates.js';
import { createTaskRepository, type TaskRepository } from './repositories/tasks.js';

export type { ConcordDatabase } from './connection.js';
export { openDatabase } from './connection.js';
export type { NewTask, TaskRepository } from './repositories/tasks.js';
export type { NewHandoff, HandoffRepository } from './repositories/handoffs.js';
export type { NewReview, ReviewRepository } from './repositories/reviews.js';
export type { NewTaskUpdate, TaskUpdateRepository } from './repositories/task-updates.js';
export type { NewEvent, EventRepository } from './repositories/events.js';
export type { NewAgent, AgentRepository } from './repositories/agents.js';
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
} from './rows.js';

/** The full set of Concord repositories bound to one database. */
export interface Repositories {
  db: ConcordDatabase;
  tasks: TaskRepository;
  handoffs: HandoffRepository;
  reviews: ReviewRepository;
  taskUpdates: TaskUpdateRepository;
  events: EventRepository;
  agents: AgentRepository;
}

/** Bind all repositories to an already-open database. */
export function createRepositories(db: ConcordDatabase): Repositories {
  return {
    db,
    tasks: createTaskRepository(db),
    handoffs: createHandoffRepository(db),
    reviews: createReviewRepository(db),
    taskUpdates: createTaskUpdateRepository(db),
    events: createEventRepository(db),
    agents: createAgentRepository(db),
  };
}

/** Open the database at `filename` and bind all repositories. */
export function openRepositories(filename: string): Repositories {
  return createRepositories(openDatabase(filename));
}
