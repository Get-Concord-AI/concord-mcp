import { existsSync, renameSync } from 'node:fs';

import { listCloudAgents, type CloudAgent } from '../../cloud/runtime.js';
import { obsoleteLinkPath, readCredentials } from '../../cloud/settings.js';
import { databasePath, resolveRepoRoot } from '../../config/paths.js';
import { globalDatabasePath } from '../../config/user-config.js';
import { archiveStore } from '../../db/archive.js';
import { countTasksReadOnly } from '../../db/read-only.js';
import { CLAIMED_STATUSES } from '../../domain/overlap.js';
import type { Fetch } from '../../cloud/client.js';
import { gitOriginRemote, type OriginRemote } from '../../workspaces/store.js';
import { apiCheckLines, folderLine, loginLine, machineLine } from './cloud.js';
import { cloudAccess, HOOK_TIMEOUT_MS } from './cloud-inbox.js';

/**
 * `concord doctor` on a machine linked to Concord Cloud. It checks the link and
 * the cloud, and never creates or migrates a local store: a doctor run that did
 * once left a repository stranded off the cloud. Stores are only read, or moved
 * aside when the user asks.
 */

/** Local Concord state a linked machine no longer reads. */
export interface Leftover {
  readonly path: string;
  readonly description: string;
  /** A SQLite store, which moves with its write-ahead log; otherwise a plain file. */
  readonly store: boolean;
}

/** The leftovers for this folder and this machine, found without opening anything for writing. */
export function findLeftovers(repoRoot: string, env: NodeJS.ProcessEnv): Leftover[] {
  const stores = [
    { path: databasePath(repoRoot), label: "this repository's local store" },
    { path: globalDatabasePath(env), label: "this machine's global-mode store" },
  ];
  const leftovers: Leftover[] = stores
    .filter((store) => existsSync(store.path))
    .map((store) => {
      const open = countTasksReadOnly(store.path, [...CLAIMED_STATUSES]);
      return {
        path: store.path,
        description: `${store.label}, ${
          open === undefined ? 'unreadable by this version' : `${String(open)} open task(s)`
        }`,
        store: true,
      };
    });
  const link = obsoleteLinkPath(repoRoot);
  if (existsSync(link)) {
    leftovers.push({
      path: link,
      description: 'a repository link from before Concord 0.17, which nothing reads',
      store: false,
    });
  }
  return leftovers;
}

/** What moving leftovers aside did. */
export interface ArchiveReport {
  readonly moved: string[];
  /** Stores a running process still has open, left exactly as they were. */
  readonly inUse: string[];
}

/**
 * Moves leftovers aside with an `.archived-<time>` suffix, only when the user
 * asks. Nothing is deleted: a store's open work, including any still in its
 * write-ahead log, stays readable for whoever wants it back, and a store some
 * process still has open is not touched.
 */
export function archiveLeftovers(
  leftovers: readonly Leftover[],
  now: Date = new Date(),
): ArchiveReport {
  const suffix = `.archived-${now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z')}`;
  const report: ArchiveReport = { moved: [], inUse: [] };
  for (const leftover of leftovers) {
    const archived = `${leftover.path}${suffix}`;
    if (leftover.store) {
      const result = archiveStore(leftover.path, archived);
      if (result.kind === 'moved') report.moved.push(...result.paths);
      else report.inUse.push(leftover.path);
    } else if (existsSync(leftover.path)) {
      renameSync(leftover.path, archived);
      report.moved.push(archived);
    }
  }
  return report;
}

/** Agent ids that name more than one agent: messages to them cannot be delivered. */
export function duplicateAgentKeys(agents: readonly CloudAgent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.agentKey, (counts.get(agent.agentKey) ?? 0) + 1);
  return new Map([...counts].filter(([, count]) => count > 1));
}

/** The organization's agents, and any ids shared by several: messages to those cannot be delivered. */
async function agentLines(
  cwd: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: Fetch,
): Promise<{ readonly lines: string[]; readonly healthy: boolean }> {
  const access = cloudAccess(cwd, { timeoutMs: HOOK_TIMEOUT_MS }, env);
  if (access.kind !== 'cloud') {
    const reason = access.kind === 'unusable' ? access.reason : 'not linked';
    return { lines: [`Agents: not checked (${reason})`], healthy: false };
  }
  try {
    const agents = await listCloudAgents({ ...access.runtime, fetch: fetchImpl });
    const duplicates = [...duplicateAgentKeys(agents)];
    return {
      lines: [
        `Agents: ${String(agents.length)} in your organization`,
        duplicates.length === 0
          ? 'Agent ids: unique'
          : `Agent ids: shared by several agents, so messages to them cannot be delivered: ${duplicates
              .map(([agentKey, count]) => `${agentKey} (${String(count)})`)
              .join(', ')}`,
      ],
      healthy: duplicates.length === 0,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { lines: [`Agents: not checked (${reason})`], healthy: false };
  }
}

export interface CloudDoctorDeps {
  readonly fetch: Fetch;
  readonly originRemote: OriginRemote;
  /** Whether to move leftovers aside; asked only when there are some. */
  readonly cleanLocal: (leftovers: readonly Leftover[]) => Promise<boolean>;
}

/** The cloud half of the doctor report, and whether everything it checks is healthy. */
export async function buildCloudDoctorReport(
  cwd: string,
  env: NodeJS.ProcessEnv,
  deps: CloudDoctorDeps = {
    fetch,
    originRemote: gitOriginRemote,
    cleanLocal: () => Promise.resolve(false),
  },
): Promise<{ readonly output: string; readonly healthy: boolean }> {
  const repoRoot = resolveRepoRoot(cwd, env);
  const credentials = readCredentials(env);
  const api =
    credentials === undefined
      ? { lines: [], healthy: false }
      : await apiCheckLines(credentials, { env, fetch: deps.fetch });
  const agents = await agentLines(cwd, env, deps.fetch);

  const lines = [
    'Concord doctor',
    '',
    'Concord Cloud',
    ...[
      loginLine(credentials),
      machineLine(env),
      folderLine(repoRoot, { env, originRemote: deps.originRemote }),
      ...api.lines,
      ...agents.lines,
    ].map((line) => `  ${line}`),
    '',
    'Local state (unused while this machine is linked)',
  ];

  const leftovers = findLeftovers(repoRoot, env);
  if (leftovers.length === 0) {
    lines.push('  none');
  } else {
    for (const leftover of leftovers) lines.push(`  ${leftover.path}: ${leftover.description}`);
    if (await deps.cleanLocal(leftovers)) {
      const archived = archiveLeftovers(leftovers);
      for (const path of archived.moved) lines.push(`  moved aside -> ${path}`);
      for (const path of archived.inUse) {
        lines.push(
          `  left in place: ${path} is open in a running Concord process; stop it, then run ` +
            '`concord doctor --clean-local` again',
        );
      }
    } else {
      lines.push('  `concord doctor --clean-local` moves these aside; nothing is deleted.');
    }
  }

  return { output: lines.join('\n'), healthy: api.healthy && agents.healthy };
}
