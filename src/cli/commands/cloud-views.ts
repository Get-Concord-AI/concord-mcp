import { z } from 'zod';

import { renderRosterLines } from '../../artifacts/work-state-view.js';
import { cloudSessionFor, connectCloud } from '../../cloud/proxy.js';
import {
  listCloudAgents,
  listCloudTasks,
  TASK_PAGE,
  type CloudRuntime,
} from '../../cloud/runtime.js';
import { agentStatusValues } from '../../db/rows.js';
import { deriveLiveness, type PresenceEntry } from '../../domain/presence.js';
import { cloudAccess } from './cloud-inbox.js';

/**
 * `who`, `tasks` and `status` in a repository linked to Concord Cloud: the
 * organization's agents and the project's tasks as the cloud holds them, not
 * the empty local database. None records telemetry.
 */

function heading(runtime: CloudRuntime): string {
  return `Workspace: Concord Cloud ${runtime.projectKey} (${runtime.apiUrl})`;
}

const agentStatus = z.enum(agentStatusValues).catch('active');

/** Everyone in the organization, on any machine, liveliest first. */
export async function runCloudWho(
  runtime: CloudRuntime,
  now: number = Date.now(),
): Promise<string> {
  const roster: PresenceEntry[] = (await listCloudAgents(runtime))
    .map((agent) => ({
      agentId: agent.agentKey,
      kind: agent.kind,
      owner: null,
      summary: agent.summary,
      status: agentStatus.parse(agent.status),
      liveness: deriveLiveness(agent.lastSeenAt, now),
      lastSeen: agent.lastSeenAt,
      ageSeconds: Math.max(0, Math.floor((now - Date.parse(agent.lastSeenAt)) / 1000)),
    }))
    .filter((entry) => entry.liveness !== 'archived')
    // Liveness only decays with time, so the most recently seen are the liveliest.
    .sort((first, second) => second.lastSeen.localeCompare(first.lastSeen));
  return [heading(runtime), "Who's here", ...renderRosterLines(roster)].join('\n');
}

/** The project's tasks, in the local `tasks` table's layout, holders by key. */
export async function runCloudTasks(runtime: CloudRuntime): Promise<string> {
  const [tasks, agents] = await Promise.all([listCloudTasks(runtime), listCloudAgents(runtime)]);
  if (tasks.length === 0) {
    return [heading(runtime), 'No tasks yet. Agents create tasks by calling start_work.'].join(
      '\n',
    );
  }
  const keys = new Map(agents.map((agent) => [agent.id, agent.agentKey]));
  const holder = (id: string | null) => (id === null ? undefined : keys.get(id));
  const rows = tasks.map((task) => {
    const agent = holder(task.agentId) ?? holder(task.assignedAgentId) ?? '-';
    return `${task.taskKey.padEnd(10)} ${task.status.padEnd(13)} v${String(task.version).padEnd(4)} ${agent.padEnd(18)} ${task.updatedAt} ${task.title}`;
  });
  // A full page may not be all of them: the cloud returns the most recent first.
  const more =
    tasks.length >= TASK_PAGE
      ? [
          `Showing the ${String(TASK_PAGE)} most recently updated tasks; see the dashboard for older ones.`,
        ]
      : [];
  return [heading(runtime), ...rows, ...more].join('\n');
}

const toolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/** The workspace as agents see it: the cloud's own `inspect_work` overview. */
export async function runCloudStatus(runtime: CloudRuntime): Promise<string> {
  const session = cloudSessionFor(runtime.repoRoot, process.env, undefined, runtime.checkoutRoot);
  if (session === undefined)
    throw new Error('This repository is no longer linked to Concord Cloud.');
  const client = await connectCloud(session);
  try {
    const raw: unknown = await client.callTool({ name: 'inspect_work', arguments: {} });
    const result = toolResult.parse(raw);
    const text = result.content
      .flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : []))
      .join('\n');
    if (result.isError === true) {
      throw new Error(`Concord Cloud could not show the workspace: ${text}`);
    }
    return [heading(runtime), text].join('\n');
  } finally {
    await client.close();
  }
}

/** Why `export` does nothing here: its artifacts are written from the local database. */
export const CLOUD_EXPORT_MESSAGE =
  'This repository is linked to Concord Cloud, where its work state lives; `concord export` ' +
  'writes artifacts from the local database. See the dashboard at https://app.getconcord.ai.';

/** Runs `view` against the cloud for a linked repository; undefined when it is local. */
export async function inCloud(
  cwd: string,
  view: (runtime: CloudRuntime) => Promise<string>,
): Promise<string | undefined> {
  const access = cloudAccess(cwd);
  if (access.kind === 'local') return undefined;
  if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
  return view(access.runtime);
}
