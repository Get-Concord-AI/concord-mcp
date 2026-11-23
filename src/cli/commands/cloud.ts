import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { Command } from '@commander-js/extra-typings';

import {
  assertKeySafeUrl,
  fetchMeta,
  incompatibility,
  registerMachine,
  type Fetch,
} from '../../cloud/client.js';
import {
  ensureMachineKey,
  readCredentials,
  readMachineKey,
  removeCredentials,
  writeCredentials,
  type CloudCredentials,
} from '../../cloud/settings.js';
import { browserLogin, type BrowserLoginDeps } from '../../cloud/browser-login.js';
import { cloudTargetFor, linkedMachine } from '../../cloud/target.js';
import { resolveRepoRoot } from '../../config/paths.js';
import { writeUserConfig } from '../../config/user-config.js';
import { gitOriginRemote } from '../../workspaces/store.js';
import { VERSION } from '../../version.js';
import {
  checkLogin,
  cloudAgentsReport,
  cloudStatusReport,
  runCloudAgents,
} from './cloud-report.js';

/**
 * `concord cloud` — connecting this machine to Concord Cloud. Linking is a
 * property of the machine: linked, every folder works through the cloud.
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
  // Signing in links the machine: that is what signing in is for.
  writeUserConfig(deps.env, { cloudLink: true });
  return `Logged in to ${apiUrl} (API v${String(meta.apiVersion)}) ${
    'apiKey' in credentials ? `with key ${maskKey(credentials.apiKey)}` : 'through the browser'
  }. This machine is linked: its agents work through Concord Cloud in every folder.`;
}

export function runCloudLogout(deps: CloudDeps): string {
  return removeCredentials(deps.env)
    ? "Logged out; this machine's agents use local Concord again."
    : 'Not logged in.';
}

/**
 * Link this machine: from now on every Concord operation in every folder goes
 * through Concord Cloud. Logging in links too; this undoes `unlink` without
 * signing in again.
 */
export function runCloudLink(deps: CloudDeps): string {
  const credentials = readCredentials(deps.env);
  if (credentials === undefined) {
    throw new Error('Not logged in; run `concord cloud login`, which also links this machine.');
  }
  if (readMachineKey(deps.env) === undefined) {
    throw new Error('This machine has no Concord Cloud identity; run `concord cloud login` again.');
  }
  const wasLinked = linkedMachine(deps.env) !== undefined;
  writeUserConfig(deps.env, { cloudLink: true });
  return wasLinked
    ? `This machine is already linked to ${credentials.apiUrl}.`
    : `Linked this machine to ${credentials.apiUrl}: its agents work through Concord Cloud in every folder.`;
}

/** Unlink this machine: its agents use local Concord, and the login stays for `link`. */
export function runCloudUnlink(deps: CloudDeps): string {
  if (linkedMachine(deps.env) === undefined) {
    return 'This machine is not linked; its agents already use local Concord.';
  }
  writeUserConfig(deps.env, { cloudLink: false });
  return (
    'Unlinked this machine: its agents use local Concord. You are still signed in; ' +
    '`concord cloud link` reconnects it.'
  );
}

/** Whether this machine is linked, and if not, why. */
export function machineLine(env: NodeJS.ProcessEnv): string {
  if (linkedMachine(env) !== undefined) {
    return "Machine: linked; every folder's agents work through Concord Cloud";
  }
  if (readCredentials(env) === undefined) return 'Machine: not linked (not signed in)';
  if (readMachineKey(env) === undefined) {
    return 'Machine: not linked: it has no Concord Cloud identity; run `concord cloud login` again';
  }
  return 'Machine: not linked (`concord cloud unlink`); `concord cloud link` reconnects it';
}

/** Where this folder's Concord work lives. */
export function folderLine(
  repoRoot: string,
  deps: Pick<CloudDeps, 'env' | 'originRemote'>,
): string {
  const target = cloudTargetFor(repoRoot, deps.env, deps.originRemote);
  return target === undefined
    ? `Here: ${repoRoot} uses local Concord`
    : `Here: ${repoRoot} is ${target.projectKey} on Concord Cloud`;
}

/** The saved login, with an API key masked. */
export function loginLine(credentials: CloudCredentials | undefined): string {
  return credentials === undefined
    ? 'Login: none (run `concord cloud login`)'
    : `Login: ${credentials.apiUrl} ${
        'apiKey' in credentials
          ? `with key ${maskKey(credentials.apiKey)}`
          : 'signed in through the browser'
      }`;
}

/**
 * Whether the login's API answers and accepts its key: two checks, reported
 * apart, so a failing key check never hides an API that answered.
 */
export async function apiCheckLines(
  credentials: CloudCredentials,
  deps: Pick<CloudDeps, 'env' | 'fetch'>,
): Promise<{ readonly lines: string[]; readonly healthy: boolean }> {
  const { api, key } = await checkLogin(credentials, deps);
  return {
    lines: [
      'unreachable' in api
        ? `API: unreachable (${api.unreachable})`
        : api.problem === null
          ? `API: reachable, v${String(api.version)}, compatible`
          : `API: reachable but ${api.problem}`,
      key === 'accepted'
        ? 'Key: accepted'
        : key === 'rejected'
          ? 'Key: rejected — log in again'
          : `Key: not checked (${key.unchecked})`,
    ],
    healthy: !('unreachable' in api) && api.problem === null && key === 'accepted',
  };
}

export async function runCloudStatus(deps: CloudDeps): Promise<string> {
  const repoRoot = resolveRepoRoot(deps.cwd, deps.env);
  const credentials = readCredentials(deps.env);
  const lines = [loginLine(credentials), machineLine(deps.env), folderLine(repoRoot, deps)];
  if (credentials !== undefined) lines.push(...(await apiCheckLines(credentials, deps)).lines);
  return lines.join('\n');
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
    originRemote: gitOriginRemote,
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
  const cloud = program.command('cloud').description('Connect this machine to Concord Cloud');

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
    .description('Work through Concord Cloud in every folder on this machine (login does this too)')
    .action(() => report(() => runCloudLink(liveDeps())));

  cloud
    .command('unlink')
    .description('Use local Concord on this machine, staying signed in')
    .action(() => report(() => runCloudUnlink(liveDeps())));

  cloud
    .command('status')
    .description('Show the login, whether this machine is linked, and whether the API is usable')
    .option('--json', 'print it as JSON, for scripts')
    .action((options) =>
      report(async () =>
        options.json === true
          ? JSON.stringify(await cloudStatusReport(liveDeps()), null, 2)
          : runCloudStatus(liveDeps()),
      ),
    );

  cloud
    .command('agents')
    .description('List the agents Concord Cloud has seen on this machine')
    .option('--json', 'print them as JSON, for scripts')
    .action((options) =>
      report(async () =>
        options.json === true
          ? JSON.stringify(await cloudAgentsReport(liveDeps()), null, 2)
          : runCloudAgents(liveDeps()),
      ),
    );
}
