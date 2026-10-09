import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { Command } from '@commander-js/extra-typings';

import {
  assertKeySafeUrl,
  checkKey,
  fetchMeta,
  incompatibility,
  registerMachine,
  sameApi,
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
  type CloudCredentials,
} from '../../cloud/settings.js';
import { browserLogin, type BrowserLoginDeps } from '../../cloud/browser-login.js';
import { bearerFor } from '../../cloud/tokens.js';
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
  /** For browser login: open a URL, tell the person, read a pasted code. */
  readonly browser: Omit<BrowserLoginDeps, 'fetch'>;
}

/** Concord Cloud, unless `--url` names another deployment. */
export const DEFAULT_API_URL = 'https://api.getconcord.ai';

export const API_KEY_ENV = 'CONCORD_CLOUD_API_KEY';

/** A key shown in output: enough to tell keys apart, never enough to use one. */
function maskKey(apiKey: string): string {
  return `${apiKey.slice(0, 7)}…`;
}

export async function runCloudLogin(
  options: { readonly url?: string; readonly keyStdin?: boolean; readonly browser?: boolean },
  deps: CloudDeps,
): Promise<string> {
  const apiUrl = options.url ?? DEFAULT_API_URL;
  // A key only ever from stdin or the environment: a flag lands in shell history.
  const apiKey = (
    options.keyStdin === true ? await deps.readStdin() : (deps.env[API_KEY_ENV] ?? '')
  ).trim();
  if (options.keyStdin === true && apiKey === '') {
    throw new Error('No API key arrived on stdin.');
  }

  assertKeySafeUrl(apiUrl);
  const meta = await fetchMeta(apiUrl, deps.fetch);
  const problem = incompatibility(meta);
  if (problem !== null) {
    throw new Error(`Cannot use ${apiUrl}: ${problem}.`);
  }

  let credentials: CloudCredentials;
  if (apiKey !== '') {
    credentials = { apiUrl, apiKey };
  } else if (meta.cliLogin !== undefined) {
    const oauth = await browserLogin(
      meta.cliLogin,
      { paste: options.browser === false },
      { ...deps.browser, fetch: deps.fetch },
    );
    credentials = { apiUrl, oauth };
  } else {
    throw new Error(
      `${apiUrl} offers no browser login; pass an API key with --key-stdin or ${API_KEY_ENV}.`,
    );
  }
  const bearer = 'apiKey' in credentials ? credentials.apiKey : credentials.oauth.accessToken;

  // Kept across logins and logouts, so this machine stays one machine.
  const machineKey = ensureMachineKey(deps.env, deps.newMachineKey);
  const host = deps.hostname();
  const registered = await registerMachine(
    apiUrl,
    bearer,
    { machineKey, name: host, hostname: host, platform: process.platform, runtimeVersion: VERSION },
    deps.fetch,
  );
  if (registered === 'rejected') {
    throw new Error(
      `${apiUrl} rejected ${'apiKey' in credentials ? 'that API key' : 'the sign-in'}.`,
    );
  }

  writeCredentials(deps.env, credentials);
  return `Logged in to ${apiUrl} (API v${String(meta.apiVersion)}) ${
    'apiKey' in credentials ? `with key ${maskKey(credentials.apiKey)}` : 'through the browser'
  }.`;
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
      : `Login: ${credentials.apiUrl} ${
          'apiKey' in credentials
            ? `with key ${maskKey(credentials.apiKey)}`
            : 'signed in through the browser'
        }`,
    link === undefined
      ? `Repository: ${repoRoot} is local (not linked)`
      : `Repository: ${repoRoot} is linked to ${link.projectKey} on ${link.apiUrl}`,
  ];

  if (
    credentials !== undefined &&
    link !== undefined &&
    !sameApi(link.apiUrl, credentials.apiUrl)
  ) {
    lines.push(
      `Warning: linked to ${link.apiUrl}, but logged in to ${credentials.apiUrl}; ` +
        'the checks below are for the login, and cloud mode will refuse this pair.',
    );
  }

  if (credentials !== undefined) {
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
      lines.push(`API: unreachable (${error instanceof Error ? error.message : String(error)})`);
    }
    try {
      const bearer = await bearerFor(deps.env, credentials.apiUrl, deps.fetch)();
      const key = await checkKey(credentials.apiUrl, bearer, deps.fetch);
      lines.push(key === 'ok' ? 'Key: accepted' : 'Key: rejected — log in again');
    } catch (error) {
      lines.push(`Key: not checked (${error instanceof Error ? error.message : String(error)})`);
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

/**
 * How to open a URL in the browser on each platform, with the URL passed as a
 * single argument and never through a shell. On Windows that rules out
 * `cmd /c start`: `cmd` reads `&` (in every OAuth URL) as a command separator.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

function openUrl(url: string): void {
  const [command, args] = browserCommand(process.platform, url);
  // Fire and forget: the link is printed too, for when no browser opens.
  spawn(command, args, { stdio: 'ignore', detached: true, shell: false })
    .on('error', () => undefined)
    .unref();
}

async function readLine(): Promise<string> {
  const lines = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of lines) return line;
    return '';
  } finally {
    lines.close();
  }
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
    browser: {
      openUrl,
      print: (line) => process.stderr.write(`${line}\n`),
      readLine,
    },
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
    .description(
      `Sign in to Concord Cloud in the browser, or with an API key (stdin or ${API_KEY_ENV})`,
    )
    .option('--url <url>', `Concord Cloud API URL (default ${DEFAULT_API_URL})`)
    .option('--key-stdin', 'read an API key from stdin instead of signing in')
    .option('--no-browser', 'show a sign-in link and paste the code back (for SSH sessions)')
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
