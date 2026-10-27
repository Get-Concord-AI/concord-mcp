import { existsSync } from 'node:fs';

import { listCloudAgents, type CloudAgent } from '../../cloud/runtime.js';
import { obsoleteLinkPath, readCredentials } from '../../cloud/settings.js';
import { databasePath, resolveRepoRoot } from '../../config/paths.js';
import { globalDatabasePath } from '../../config/user-config.js';
import { countTasksReadOnly } from '../../db/read-only.js';
import { CLAIMED_STATUSES } from '../../domain/overlap.js';
import type { Fetch } from '../../cloud/client.js';
import { gitOriginRemote, type OriginRemote } from '../../workspaces/store.js';
import { apiCheckLines, folderLine, loginLine, machineLine } from './cloud.js';
import { cloudAccess, HOOK_TIMEOUT_MS } from './cloud-inbox.js';

/**
 * `concord doctor` on a machine linked to Concord Cloud. It checks the link and
 * the cloud, and never creates, migrates or moves a local store: a doctor run
 * that created one once left a repository stranded off the cloud.
 *
 * Leftover stores are reported, with the commands to move them aside, and left
 * for the user to move. Nothing can stop another process opening a file, so a
 * store moved by code could still be split by a session that opened it first;
 * only the person running the machine knows when no such session remains.
 */

/** Local Concord state a linked machine no longer reads. */
export interface Leftover {
  readonly path: string;
  readonly description: string;
  /** The files to move together: a store's write-ahead log and shared memory go with it. */
  readonly files: readonly string[];
}

/** SQLite pairs a store with these by appending them to its name. */
const COMPANION_SUFFIXES = ['-wal', '-shm'] as const;

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
          open === undefined
            ? 'open tasks not counted (in use, or unreadable by this version)'
            : `${String(open)} open task(s)`
        }`,
        files: ['', ...COMPANION_SUFFIXES]
          .map((suffix) => `${store.path}${suffix}`)
          .filter((path) => existsSync(path)),
      };
    });
  const link = obsoleteLinkPath(repoRoot);
  if (existsSync(link)) {
    leftovers.push({
      path: link,
      description: 'a repository link from before Concord 0.17, which nothing reads',
      files: [link],
    });
  }
  return leftovers;
}

/** A path quoted for a POSIX shell. */
function posixQuote(path: string): string {
  return `'${path.replace(/'/gu, `'\\''`)}'`;
}

/** A path quoted for PowerShell, which doubles a single quote inside one. */
function powershellQuote(path: string): string {
  return `'${path.replace(/'/gu, "''")}'`;
}

/**
 * One move, in the shell of the platform: `mv -n` on POSIX and `Move-Item`
 * without `-Force` on Windows, so neither ever replaces an existing file.
 */
function moveCommand(from: string, to: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? `Move-Item -LiteralPath ${powershellQuote(from)} -Destination ${powershellQuote(to)}`
    : `mv -n ${posixQuote(from)} ${posixQuote(to)}`;
}

/**
 * The commands that move leftovers aside, for the user to run. Each run names
 * a fresh archive (`.archived-<time>`), and the commands refuse to overwrite,
 * so an earlier archive is never replaced. A store keeps SQLite's pairing
 * (`concord.db.archived-<time>-wal`, never `concord.db-wal.archived-<time>`),
 * so a log still holding committed work stays with its database.
 */
export function moveAsideCommands(
  leftovers: readonly Leftover[],
  now: Date = new Date(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const stamp = now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');
  return leftovers.flatMap((leftover) =>
    leftover.files.map((file) => {
      const suffix = file.slice(leftover.path.length);
      return moveCommand(file, `${leftover.path}.archived-${stamp}${suffix}`, platform);
    }),
  );
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
  /** Whose shell the suggested commands are for; this machine's unless a test says otherwise. */
  readonly platform?: NodeJS.Platform;
}

/** The cloud half of the doctor report, and whether everything it checks is healthy. */
export async function buildCloudDoctorReport(
  cwd: string,
  env: NodeJS.ProcessEnv,
  deps: CloudDoctorDeps = {
    fetch,
    originRemote: gitOriginRemote,
  },
): Promise<{ readonly output: string; readonly healthy: boolean }> {
  const repoRoot = resolveRepoRoot(cwd, env);
  const platform = deps.platform ?? process.platform;
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
    lines.push(
      '  Nothing reads these while this machine is linked. Once every Concord session ' +
        `started before the link has ended, you can move them aside (nothing is deleted)${
          platform === 'win32' ? ', in PowerShell' : ''
        }:`,
      ...moveAsideCommands(leftovers, new Date(), platform).map((command) => `    ${command}`),
    );
  }

  return { output: lines.join('\n'), healthy: api.healthy && agents.healthy };
}
