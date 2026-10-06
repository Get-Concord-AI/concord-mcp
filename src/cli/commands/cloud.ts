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
import { ensureMachineKey, removeCredentials, writeCredentials } from '../../cloud/settings.js';
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
}
