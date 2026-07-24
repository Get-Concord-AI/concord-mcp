import type { TaskRecord } from '../db/index.js';
import type { PresenceEntry } from '../domain/presence.js';

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

interface WorkStatePresence {
  agent_id: string;
  kind: string;
  owner: string | null;
  summary: string | null;
  status: string;
  liveness: string;
  last_seen: string;
  age_seconds: number;
}

interface WorkState {
  generated_at: string;
  presence: WorkStatePresence[];
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

function toWorkStatePresence(entry: PresenceEntry): WorkStatePresence {
  return {
    agent_id: entry.agentId,
    kind: entry.kind,
    owner: entry.owner,
    summary: entry.summary,
    status: entry.status,
    liveness: entry.liveness,
    last_seen: entry.lastSeen,
    age_seconds: entry.ageSeconds,
  };
}

/** Render WORK_STATE.json: a snapshot of the agent roster and all tasks. */
export function renderWorkStateJson(
  tasks: readonly TaskRecord[],
  roster: readonly PresenceEntry[],
  generatedAt: string,
): string {
  const state: WorkState = {
    generated_at: generatedAt,
    presence: roster.map(toWorkStatePresence),
    tasks: tasks.map(toWorkStateTask),
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}
