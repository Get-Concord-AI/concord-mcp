import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { Command } from '@commander-js/extra-typings';

import {
  assertKeySafeUrl,
  checkKey,
  fetchMeta,
  incompatibility,
  registerMachine,
  type Fetch,
} from '../../cloud/client.js';
import {
  ensureMachineKey,
  readCredentials,
  readLink,
  removeCredentials,
  removeLink,
  writeCredentials,
  writeLink,
} from '../../cloud/settings.js';
import { resolveRepoRoot } from '../../config/paths.js';
import { normalizeProjectKey } from '../../domain/project-key.js';
import { VERSION } from '../../version.js';

/**
 * `concord cloud` — connecting this machine and a repository to Concord Cloud.
 * Non-local operations, so the CLI records no telemetry for them.
 */

export interface CloudDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly fetch: Fetch;
  /** Reads a secret piped on stdin, for `--key-stdin`. */
  readonly readStdin: () => Promise<string>;
  /** The repository's `origin` remote, or undefined when there is none. */
  readonly originRemote: (repoRoot: string) => string | undefined;
  readonly hostname: () => string;
  readonly newMachineKey: () => string;
}

export const API_KEY_ENV = 'CONCORD_CLOUD_API_KEY';

/** A key shown in output: enough to tell keys apart, never enough to use one. */
function maskKey(apiKey: string): string {
  return `${apiKey.slice(0, 7)}…`;
}

export async function runCloudLogin(
  options: { readonly url: string; readonly keyStdin?: boolean },
  deps: CloudDeps,
): Promise<string> {
  // Never from a flag: a key on the command line lands in shell history.
  const apiKey = (
    options.keyStdin === true ? await deps.readStdin() : (deps.env[API_KEY_ENV] ?? '')
  ).trim();
  if (apiKey === '') {
    throw new Error(`Pass the API key on stdin with --key-stdin, or set ${API_KEY_ENV}.`);
  }

  assertKeySafeUrl(options.url);
  const meta = await fetchMeta(options.url, deps.fetch);
  const problem = incompatibility(meta);
  if (problem !== null) {
    throw new Error(`Cannot use ${options.url}: ${problem}.`);
  }
  // Kept across logins and logouts, so this machine stays one machine.
  const machineKey = ensureMachineKey(deps.env, deps.newMachineKey);
  const host = deps.hostname();
  const registered = await registerMachine(
    options.url,
    apiKey,
    { machineKey, name: host, hostname: host, platform: process.platform, runtimeVersion: VERSION },
    deps.fetch,
  );
  if (registered === 'rejected') {
    throw new Error(`${options.url} rejected that API key.`);
  }

  writeCredentials(deps.env, { apiUrl: options.url, apiKey });
  return `Logged in to ${options.url} (API v${String(meta.apiVersion)}) with key ${maskKey(apiKey)}.`;
}

export function runCloudLogout(deps: CloudDeps): string {
  return removeCredentials(deps.env)
    ? 'Logged out; linked repositories stay linked but cannot reach the cloud until you log in again.'
    : 'Not logged in.';
}

export function runCloudLink(options: { readonly project?: string }, deps: CloudDeps): string {
  const credentials = readCredentials(deps.env);
  if (credentials === undefined) {
    throw new Error('Not logged in; run `concord cloud login` first.');
  }

  const repoRoot = resolveRepoRoot(deps.cwd, deps.env);
  const remote = options.project ?? deps.originRemote(repoRoot);
  if (remote === undefined) {
    throw new Error(
      'This repository has no `origin` remote. Name it with --project <remote>, ' +
        'such as github.com/org/repo, so every clone links to the same project.',
    );
  }

  const projectKey = normalizeProjectKey(remote);
  if (projectKey === null) {
    throw new Error(`"${remote}" is not a git remote, such as github.com/org/repo.`);
  }

  writeLink(repoRoot, { apiUrl: credentials.apiUrl, projectKey });
  return `Linked ${repoRoot} to ${projectKey} on ${credentials.apiUrl}.`;
}

export function runCloudUnlink(deps: CloudDeps): string {
  const repoRoot = resolveRepoRoot(deps.cwd, deps.env);
  return removeLink(repoRoot)
    ? `Unlinked ${repoRoot}; Concord stays local here.`
    : `${repoRoot} was not linked.`;
}

export async function runCloudStatus(deps: CloudDeps): Promise<string> {
  const repoRoot = resolveRepoRoot(deps.cwd, deps.env);
  const credentials = readCredentials(deps.env);
  const link = readLink(repoRoot);
  const lines = [
    credentials === undefined
      ? 'Login: none (run `concord cloud login`)'
      : `Login: ${credentials.apiUrl} with key ${maskKey(credentials.apiKey)}`,
    link === undefined
      ? `Repository: ${repoRoot} is local (not linked)`
      : `Repository: ${repoRoot} is linked to ${link.projectKey} on ${link.apiUrl}`,
  ];

  if (credentials !== undefined && link !== undefined && link.apiUrl !== credentials.apiUrl) {
    lines.push(
      `Warning: linked to ${link.apiUrl}, but logged in to ${credentials.apiUrl}; ` +
        'the checks below are for the login, and cloud mode will refuse this pair.',
    );
  }

  if (credentials !== undefined) {
    const reason = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    // Two checks, reported apart, so a failing key check never hides an API
    // that answered.
    try {
      const meta = await fetchMeta(credentials.apiUrl, deps.fetch);
      const problem = incompatibility(meta);
      lines.push(
        problem === null
          ? `API: reachable, v${String(meta.apiVersion)}, compatible`
          : `API: reachable but ${problem}`,
      );
    } catch (error) {
      lines.push(`API: unreachable (${reason(error)})`);
    }
    try {
      const key = await checkKey(credentials.apiUrl, credentials.apiKey, deps.fetch);
      lines.push(key === 'ok' ? 'Key: accepted' : 'Key: rejected — log in again');
    } catch (error) {
      lines.push(`Key: not checked (${reason(error)})`);
    }
  }

  return lines.join('\n');
}

function originRemote(repoRoot: string): string | undefined {
  const result = spawnSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  });
  const url = result.status === 0 ? result.stdout.trim() : '';
  return url === '' ? undefined : url;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function liveDeps(): CloudDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    fetch,
    readStdin,
    originRemote,
    hostname,
    newMachineKey: randomUUID,
  };
}

/** Prints a command's result, or its error as one line with a failing exit code. */
async function report(run: () => string | Promise<string>): Promise<void> {
  try {
    process.stdout.write(`${await run()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export function registerCloudCommand(program: Command): void {
  const cloud = program
    .command('cloud')
    .description('Connect this machine and repository to Concord Cloud');

  cloud
    .command('login')
    .description(`Save a Concord Cloud API key (from stdin or ${API_KEY_ENV})`)
    .requiredOption('--url <url>', 'Concord Cloud API URL')
    .option('--key-stdin', 'read the API key from stdin')
    .action((options) => report(() => runCloudLogin(options, liveDeps())));

  cloud
    .command('logout')
    .description('Forget the saved Concord Cloud API key')
    .action(() => report(() => runCloudLogout(liveDeps())));

  cloud
    .command('link')
    .description('Link this repository to Concord Cloud')
    .option('--project <remote>', 'the repository, when it has no origin remote')
    .action((options) => report(() => runCloudLink(options, liveDeps())));

  cloud
    .command('unlink')
    .description('Return this repository to local Concord')
    .action(() => report(() => runCloudUnlink(liveDeps())));

  cloud
    .command('status')
    .description('Show the login, link and whether the API is usable')
    .action(() => report(() => runCloudStatus(liveDeps())));
}
