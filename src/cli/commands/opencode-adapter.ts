import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CloudRuntime } from '../../cloud/runtime.js';
import { agentIdForSession } from '../../domain/identity.js';
import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import { sessionKey } from '../../domain/receipts.js';
import { atLeast, run, versionTuple } from '../../install/adapters/index.js';
import { opencodeExecutable } from '../../install/adapters/opencode.js';
import { runInteractive } from '../../install/spawn-command.js';
import { relayAddress } from '../../relay/address.js';
import { PushPromptSessionAdapter, type PushPromptSession } from '../../relay/adapters.js';
import { openCodeApiRunner, type OpenCodeRequest } from '../../relay/opencode-api.js';
import { OpenCodeServerClient } from '../../relay/opencode-client.js';
import { startAgentRelay } from '../../relay/server.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { openContext } from '../context.js';
import { deliverToSession } from './cloud-codex.js';
import { cloudAccess, watchCloud } from './cloud-inbox.js';
import { startSweeper, TrackedSessionAdapter } from './session-sweep.js';

/**
 * OpenCode with idle wake-up and mid-turn steering, shaped like the Copilot
 * adapter.
 *
 * OpenCode exposes no session id to the MCP servers it spawns, and the shared
 * background service (not the terminal) spawns them, so the launcher cannot
 * pass an identity through the environment. Instead `concord adapters opencode`
 * chooses the session id itself (OpenCode accepts any `ses…` id), creates the
 * session in the current directory, and admits the agent's identity as a silent
 * synthetic message (`resume: false`, so it does not start a turn). The model
 * then passes that `agent_id` on its Concord tool calls. The host relays
 * Concord messages into the session while OpenCode runs. Sessions opened any
 * other way keep the MCP tools but have no identity and no push delivery.
 */

const KIND = 'opencode';
const SESSION_FLAGS: readonly string[] = ['--session', '-s', '--continue', '-c'];
/** Flags that take a value, so the value is not mistaken for a directory. */
const VALUE_FLAGS: readonly string[] = ['--server', '--session', '-s', '--prompt'];

/** A session id OpenCode accepts (`ses…`) that is unique to this launch. */
export function newOpencodeSessionId(): string {
  return `ses_concord${randomBytes(9).toString('hex')}`;
}

/** The silent first message that tells the model who it is to Concord. */
export function identityNotice(agentId: string): string {
  return (
    `Concord identity: your agent_id is ${agentId}. ` +
    `Pass agent_id "${agentId}" on every Concord tool call.`
  );
}

/** Whether the user already chose which session OpenCode opens. */
function choosesSession(args: readonly string[]): boolean {
  return args.some((arg) =>
    SESSION_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

/** The directory OpenCode will work in: a directory argument, else where the launcher ran. */
export function launchDirectory(args: readonly string[], cwd: string): string {
  for (const [index, arg] of args.entries()) {
    const previous = args[index - 1];
    if (arg.startsWith('-') || (previous !== undefined && VALUE_FLAGS.includes(previous))) continue;
    const candidate = resolve(cwd, arg);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  return cwd;
}

/** The server the user pointed OpenCode at (`--server <url>` or `--server=<url>`), if any. */
export function serverFrom(args: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === '--server') return args[index + 1];
    if (arg.startsWith('--server=')) return arg.slice('--server='.length);
  }
  return undefined;
}

/**
 * The command line for one hosted session, or `undefined` when the user picked
 * their own session (`--session`, `--continue`): the launcher then cannot know
 * which session to host.
 */
export function opencodeLaunchPlan(
  sessionId: string,
  args: readonly string[],
): string[] | undefined {
  return choosesSession(args) ? undefined : ['--session', sessionId, ...args];
}

/** Create the session where OpenCode will run and admit the identity without starting a turn. */
export async function prepareSession(
  request: OpenCodeRequest,
  sessionId: string,
  agentId: string,
  directory: string,
): Promise<void> {
  await request(
    'POST',
    '/api/session',
    JSON.stringify({ id: sessionId, title: 'Concord session', location: { directory } }),
  );
  await request(
    'POST',
    `/api/session/${encodeURIComponent(sessionId)}/synthetic`,
    JSON.stringify({
      text: identityNotice(agentId),
      description: 'Concord agent identity',
      resume: false,
    }),
  );
}

/** Hands relay deliveries to the OpenCode session; see {@link TrackedSessionAdapter}. */
export class OpenCodeSessionAdapter extends TrackedSessionAdapter {
  constructor(session: PushPromptSession) {
    super(KIND, session);
  }
}

export interface RunningHost {
  stop(): Promise<void>;
}

/** Host one OpenCode session's local relay, in the workspace of `directory`, until stopped. */
export async function startOpencodeHost(
  agentId: string,
  sessionId: string,
  request: OpenCodeRequest,
  directory: string,
): Promise<RunningHost> {
  const context = openContext(directory);
  ensureAgentRegistered(context.repos, { agentId, kind: KIND }, context.repoRoot);
  const client = new OpenCodeServerClient({ request, sessionId });
  await client.connect();
  const adapter = new OpenCodeSessionAdapter(client);
  const relay = await startAgentRelay({
    repos: context.repos,
    agentId,
    address: relayAddress(context.concordPath, agentId),
    adapter,
    pullFallback: true,
    session: sessionKey(sessionId),
  });
  const stopSweeper = startSweeper(context.repos, agentId, adapter);
  return {
    stop: async () => {
      stopSweeper();
      client.close();
      await relay.close();
    },
  };
}

/** Host one OpenCode session's live receiver against Concord Cloud until the launcher exits. */
export async function startOpencodeCloudHost(
  runtime: CloudRuntime,
  agentId: string,
  sessionId: string,
  request: OpenCodeRequest,
): Promise<RunningHost> {
  const client = new OpenCodeServerClient({ request, sessionId });
  await client.connect();
  // deliverToSession frames each message before handing it over.
  const adapter = new PushPromptSessionAdapter(KIND, client);
  void watchCloud(runtime, agentId, KIND, false, (messages, stop) =>
    deliverToSession(runtime, agentId, adapter, messages, stop),
  ).catch(() => undefined);
  return {
    stop: () => {
      client.close();
      return Promise.resolve();
    },
  };
}

async function startHost(
  agentId: string,
  sessionId: string,
  request: OpenCodeRequest,
  directory: string,
): Promise<RunningHost> {
  const access = cloudAccess(directory);
  if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
  return access.kind === 'cloud'
    ? startOpencodeCloudHost(access.runtime, agentId, sessionId, request)
    : startOpencodeHost(agentId, sessionId, request, directory);
}

function warn(message: string): void {
  process.stderr.write(`Concord: ${message}\n`);
}

/**
 * Run OpenCode with a hosted, identified session. Anything that stops the
 * session being hosted — an old OpenCode, a session the user chose, or a setup
 * failure — starts OpenCode plain, with the MCP tools only, rather than not at all.
 */
export async function launchOpencode(args: readonly string[]): Promise<void> {
  const env = process.env;
  const executable = opencodeExecutable(env);
  if (executable === undefined) {
    throw new Error('OpenCode was not found on PATH or in the desktop app.');
  }
  const version = versionTuple(run(executable, ['--version'], env).output);
  const minimum = HARNESS_CONFIGS.opencode.minimumVersion;
  let launch: string[] = [...args];
  let host: RunningHost | undefined;

  if (version === undefined || !atLeast(version, minimum)) {
    warn(
      `idle wake-up needs OpenCode ${minimum.join('.')} or later; starting OpenCode without it.`,
    );
  } else {
    const sessionId = newOpencodeSessionId();
    const plan = opencodeLaunchPlan(sessionId, args);
    if (plan === undefined) {
      warn('you chose the session, so Concord cannot host it; starting OpenCode without it.');
    } else {
      const agentId = agentIdForSession(KIND, sessionId);
      // Concord must talk to the server OpenCode will connect to, or the session
      // it prepares would not exist there; the workspace is the one OpenCode opens.
      const request = openCodeApiRunner(executable, serverFrom(args));
      const directory = launchDirectory(args, process.cwd());
      try {
        await prepareSession(request, sessionId, agentId, directory);
        host = await startHost(agentId, sessionId, request, directory);
        launch = plan;
        warn(`this OpenCode session is agent ${agentId}.`);
      } catch (error) {
        warn(
          `could not host the session (${error instanceof Error ? error.message : String(error)}); ` +
            'starting OpenCode without it.',
        );
      }
    }
  }

  const code = await runInteractive(executable, launch, env);
  await host?.stop();
  // The cloud receiver keeps timers alive, so end the process once OpenCode exits.
  process.exit(code);
}
