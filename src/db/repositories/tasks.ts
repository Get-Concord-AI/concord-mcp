import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';
import { parseTaskRow, serializeStringArray, type TaskRecord, type TaskStatus } from '../rows.js';

/** Input for creating a task claim. Optional string fields are explicit `null`. */
export interface NewTask {
  taskId: string;
  title: string;
  owner: string | null;
  agent: string | null;
  branch: string | null;
  worktree: string | null;
  expectedFiles: readonly string[];
  modules: readonly string[];
  domains: readonly string[];
  riskTags: readonly string[];
  notes: string | null;
  parentTaskId: string | null;
}

/** The declared surface of a claim, updated when an agent re-claims with an
 * expanded scope. */
export interface TaskScope {
  expectedFiles: readonly string[];
  modules: readonly string[];
  domains: readonly string[];
  riskTags: readonly string[];
}

export interface TaskRepository {
  create(task: NewTask): TaskRecord;
  get(taskId: string): TaskRecord | undefined;
  list(): TaskRecord[];
  updateStatus(taskId: string, status: TaskStatus): TaskRecord | undefined;
  updateScope(taskId: string, scope: TaskScope): TaskRecord | undefined;
}

const rawListSchema = z.array(z.unknown());

export function createTaskRepository(db: ConcordDatabase): TaskRepository {
  const insertStmt = db.prepare(`
    INSERT INTO tasks (
      task_id, title, owner, agent, branch, worktree,
      expected_files, modules, domains, risk_tags, notes, status,
      parent_task_id, created_at, updated_at
    ) VALUES (
      @task_id, @title, @owner, @agent, @branch, @worktree,
      @expected_files, @modules, @domains, @risk_tags, @notes, @status,
      @parent_task_id, @created_at, @updated_at
    )
  `);
  const getStmt = db.prepare('SELECT * FROM tasks WHERE task_id = ?');
  const listStmt = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC, task_id ASC');
  const updateStatusStmt = db.prepare(
    'UPDATE tasks SET status = @status, updated_at = @updated_at WHERE task_id = @task_id',
  );
  const updateScopeStmt = db.prepare(
    `UPDATE tasks SET expected_files = @expected_files, modules = @modules,
       domains = @domains, risk_tags = @risk_tags, updated_at = @updated_at
     WHERE task_id = @task_id`,
  );

  function get(taskId: string): TaskRecord | undefined {
    const raw: unknown = getStmt.get(taskId);
    if (raw === undefined) {
      return undefined;
    }
    return parseTaskRow(raw);
  }

  return {
    create(task) {
      const now = new Date().toISOString();
      insertStmt.run({
        task_id: task.taskId,
        title: task.title,
        owner: task.owner,
        agent: task.agent,
        branch: task.branch,
        worktree: task.worktree,
        expected_files: serializeStringArray(task.expectedFiles),
        modules: serializeStringArray(task.modules),
        domains: serializeStringArray(task.domains),
        risk_tags: serializeStringArray(task.riskTags),
        notes: task.notes,
        status: 'active',
        parent_task_id: task.parentTaskId,
        created_at: now,
        updated_at: now,
      });
      const created = get(task.taskId);
      if (created === undefined) {
        throw new Error(`Task ${task.taskId} could not be read back after insert`);
      }
      return created;
    },
    get,
    list() {
      const raw: unknown = listStmt.all();
      return rawListSchema.parse(raw).map(parseTaskRow);
    },
    updateStatus(taskId, status) {
      updateStatusStmt.run({ task_id: taskId, status, updated_at: new Date().toISOString() });
      return get(taskId);
    },
    updateScope(taskId, scope) {
      updateScopeStmt.run({
        task_id: taskId,
        expected_files: serializeStringArray(scope.expectedFiles),
        modules: serializeStringArray(scope.modules),
        domains: serializeStringArray(scope.domains),
        risk_tags: serializeStringArray(scope.riskTags),
        updated_at: new Date().toISOString(),
      });
      return get(taskId);
    },
  };
}
