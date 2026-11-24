import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { readUserConfig } from '../config/user-config.js';
import {
  GENERAL_PROJECT,
  gitOriginRemote,
  isRepository,
  repositoryProjectKey,
  type OriginRemote,
} from '../workspaces/store.js';
import { readCredentials, readMachineKey, type CloudCredentials } from './settings.js';

/**
 * Whether Concord works through Concord Cloud, and as which project.
 *
 * Linking is a property of the machine, never of a repository. A linked machine
 * — signed in, with a machine identity, and not unlinked — sends every Concord
 * operation in every folder through the cloud, so its agents reach agents on
 * any machine. An unlinked machine is plain local Concord.
 *
 * Nothing inside a repository takes part in the decision. A local store that
 * `setup` or `doctor` left behind once silently kept a repository local on a
 * linked machine, which split one machine's agents into two networks that
 * could not message each other.
 */
export interface CloudTarget {
  readonly apiUrl: string;
  readonly projectKey: string;
}

/** A machine that works through Concord Cloud, with what it needs to act there. */
export interface LinkedMachine {
  readonly credentials: CloudCredentials;
  readonly machineKey: string;
}

/**
 * This machine, when it is linked: signed in (`concord cloud login`), with the
 * identity login gave it, and not switched off with `concord cloud unlink`.
 */
export function linkedMachine(env: NodeJS.ProcessEnv): LinkedMachine | undefined {
  if (readUserConfig(env).cloudLink === false) return undefined;
  const credentials = readCredentials(env);
  const machineKey = readMachineKey(env);
  return credentials === undefined || machineKey === undefined
    ? undefined
    : { credentials, machineKey };
}

/**
 * Why nothing opens a local store on a linked machine: its work lives in
 * Concord Cloud.
 */
export const LINKED_MACHINE_MESSAGE =
  'This machine works through Concord Cloud, so there is no local Concord store here. ' +
  'See your workspace at https://app.getconcord.ai, or run `concord cloud unlink` to use ' +
  'local Concord on this machine.';

/**
 * The host of the projects for repositories with no remote. Not a real host:
 * it only has to be a key the cloud accepts that no git remote ever produces.
 */
export const MACHINE_PROJECT_HOST = 'local.concord';

function shortHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/**
 * A repository with no remote, as a project of its own on this machine. It
 * stays on the cloud, so its agents still reach every other agent, but nothing
 * else shares its claims: two unrelated scratch repositories both editing
 * `src/index.ts` must not block each other. The folder name keeps it readable
 * in the dashboard; the hashes keep it unique without publishing the path or
 * the machine key.
 */
export function machineProjectKey(machineKey: string, repoRoot: string): string {
  const name = basename(repoRoot)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 40);
  return `${MACHINE_PROJECT_HOST}/${shortHash(machineKey, 12)}/${name === '' ? 'repo' : name}-${shortHash(repoRoot, 8)}`;
}

/** Each repository's remote, asked of git once per process: hooks resolve this on every edit. */
const remotes = new Map<string, string | undefined>();
function cachedOriginRemote(repoRoot: string): string | undefined {
  if (!remotes.has(repoRoot)) remotes.set(repoRoot, gitOriginRemote(repoRoot));
  return remotes.get(repoRoot);
}

/**
 * The cloud project a folder works in on a linked machine, or undefined on an
 * unlinked one. A repository is its git remote's project, as every clone names
 * it; one with no remote is a project of its own on this machine; anything
 * outside a repository is `general`, where agents that belong to no repository
 * meet.
 */
export function cloudTargetFor(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  originRemote: OriginRemote = cachedOriginRemote,
): CloudTarget | undefined {
  const machine = linkedMachine(env);
  if (machine === undefined) return undefined;

  const projectKey = isRepository(repoRoot)
    ? (repositoryProjectKey(repoRoot, originRemote) ??
      machineProjectKey(machine.machineKey, repoRoot))
    : GENERAL_PROJECT;
  return { apiUrl: machine.credentials.apiUrl, projectKey };
}
