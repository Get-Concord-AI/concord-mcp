import {
  agentsOnMachine,
  checkKey,
  fetchMeta,
  incompatibility,
  type AgentSighting,
} from '../../cloud/client.js';
import { readCredentials, readMachineKey, type CloudCredentials } from '../../cloud/settings.js';
import { cloudTargetFor, linkedMachine } from '../../cloud/target.js';
import { bearerFor } from '../../cloud/tokens.js';
import { resolveRepoRoot } from '../../config/paths.js';
import { isRepository } from '../../workspaces/store.js';
import type { CloudDeps } from './cloud.js';

/**
 * What this machine is to Concord Cloud, as data: the checks behind
 * `concord cloud status`, and the `--json` reports of `status` and `agents`.
 * The JSON is a stable contract for scripts and the Concord Cloud setup
 * wizard; bump `schema` on any change a reader could trip over.
 */

/** The `schema` both JSON reports carry. */
export const REPORT_SCHEMA = 1;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the login's API answers and accepts its key: two checks, kept apart
 * so a failing key check never hides an API that answered.
 */
export interface LoginCheck {
  readonly api:
    | { readonly version: number; readonly problem: string | null }
    | { readonly unreachable: string };
  readonly key: 'accepted' | 'rejected' | { readonly unchecked: string };
}

export async function checkLogin(
  credentials: CloudCredentials,
  deps: Pick<CloudDeps, 'env' | 'fetch'>,
): Promise<LoginCheck> {
  let api: LoginCheck['api'];
  try {
    const meta = await fetchMeta(credentials.apiUrl, deps.fetch);
    api = { version: meta.apiVersion, problem: incompatibility(meta) };
  } catch (error) {
    api = { unreachable: message(error) };
  }
  let key: LoginCheck['key'];
  try {
    const bearer = await bearerFor(deps.env, credentials.apiUrl, deps.fetch)();
    key =
      (await checkKey(credentials.apiUrl, bearer, deps.fetch)) === 'ok' ? 'accepted' : 'rejected';
  } catch (error) {
    key = { unchecked: message(error) };
  }
  return { api, key };
}

/** `concord cloud status --json`. */
export interface CloudStatusReport {
  readonly schema: typeof REPORT_SCHEMA;
  /** The saved login, or null when signed out. */
  readonly login: { readonly apiUrl: string; readonly method: 'api-key' | 'browser' } | null;
  /** Whether the API answered and this runtime can use it; null when signed out or unreachable. */
  readonly apiCompatible: boolean | null;
  /** Whether the API accepted the login; null when signed out or it could not be checked. */
  readonly keyAccepted: boolean | null;
  /** This machine's identity to Concord Cloud, made at the first login. */
  readonly machineKey: string | null;
  /** Whether this machine works through Concord Cloud: signed in, and not unlinked. */
  readonly linked: boolean;
  readonly folder: {
    readonly root: string;
    readonly isRepository: boolean;
    /** The Concord Cloud project this folder works in, or null on an unlinked machine. */
    readonly project: string | null;
  };
}

export async function cloudStatusReport(deps: CloudDeps): Promise<CloudStatusReport> {
  const root = resolveRepoRoot(deps.cwd, deps.env);
  const credentials = readCredentials(deps.env);
  const check = credentials === undefined ? undefined : await checkLogin(credentials, deps);
  return {
    schema: REPORT_SCHEMA,
    login:
      credentials === undefined
        ? null
        : { apiUrl: credentials.apiUrl, method: 'apiKey' in credentials ? 'api-key' : 'browser' },
    apiCompatible:
      check === undefined || 'unreachable' in check.api ? null : check.api.problem === null,
    keyAccepted:
      check === undefined || typeof check.key === 'object' ? null : check.key === 'accepted',
    machineKey: readMachineKey(deps.env) ?? null,
    linked: linkedMachine(deps.env) !== undefined,
    folder: {
      root,
      isRepository: isRepository(root),
      project: cloudTargetFor(root, deps.env, deps.originRemote)?.projectKey ?? null,
    },
  };
}

/** `concord cloud agents --json`. */
export interface CloudAgentsReport {
  readonly schema: typeof REPORT_SCHEMA;
  /** False until a login registers this machine with the API. */
  readonly machineRegistered: boolean;
  /** Agents the cloud has seen on this machine, with when each last checked in. */
  readonly agents: readonly AgentSighting[];
}

/** The agents Concord Cloud has seen on this machine; refuses when signed out. */
export async function cloudAgentsReport(deps: CloudDeps): Promise<CloudAgentsReport> {
  const credentials = readCredentials(deps.env);
  const machineKey = readMachineKey(deps.env);
  if (credentials === undefined || machineKey === undefined) {
    throw new Error('Not logged in; run `concord cloud login` first.');
  }
  const bearer = await bearerFor(deps.env, credentials.apiUrl, deps.fetch)();
  const agents = await agentsOnMachine(credentials.apiUrl, bearer, machineKey, deps.fetch);
  return { schema: REPORT_SCHEMA, machineRegistered: agents !== undefined, agents: agents ?? [] };
}

export async function runCloudAgents(deps: CloudDeps): Promise<string> {
  const { machineRegistered, agents } = await cloudAgentsReport(deps);
  if (!machineRegistered) {
    return 'Concord Cloud does not know this machine; run `concord cloud login`.';
  }
  if (agents.length === 0) return 'No agent on this machine has checked in with Concord Cloud yet.';
  return agents.map((agent) => `${agent.kind.padEnd(14)} last seen ${agent.lastSeenAt}`).join('\n');
}
