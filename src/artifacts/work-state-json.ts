import type { TaskRecord } from '../db/index.js';

interface WorkStateTask {
  task_id: string;
  title: string;
  status: string;
  agent: string | null;
  owner: string | null;
  branch: string | null;
  parent_task_id: string | null;
  modules: string[];
  domains: string[];
  expected_files: string[];
}

interface WorkState {
  generated_at: string;
  tasks: WorkStateTask[];
}

function toWorkStateTask(task: TaskRecord): WorkStateTask {
  return {
    task_id: task.taskId,
    title: task.title,
    status: task.status,
    agent: task.agent,
    owner: task.owner,
    branch: task.branch,
    parent_task_id: task.parentTaskId,
    modules: task.modules,
    domains: task.domains,
    expected_files: task.expectedFiles,
  };
}

/** Render WORK_STATE.json: a snapshot of all tasks and their current status. */
export function renderWorkStateJson(tasks: readonly TaskRecord[], generatedAt: string): string {
  const state: WorkState = {
    generated_at: generatedAt,
    tasks: tasks.map(toWorkStateTask),
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}
