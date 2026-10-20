import { spawn } from 'node:child_process';

import type { CloudRuntime } from '../../cloud/runtime.js';
import { atLeast, executablePath, run, versionTuple } from '../../install/adapters/index.js';
import { relayAddress } from '../../relay/address.js';
import { renderInboxBody } from '../../domain/pull-inbox.js';
import { PushPromptSessionAdapter, type PushPromptSession } from '../../relay/adapters.js';
import { CopilotUiServerClient } from '../../relay/copilot-client.js';
import {
  startAgentRelay,
  type AgentSessionAdapter,
  type AgentSessionDelivery,
} from '../../relay/server.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { openContext } from '../context.js';
import { availablePort } from '../local-port.js';
import { deliverToSession } from './cloud-codex.js';
import { watchCloud } from './cloud-inbox.js';

/**
 * Copilot CLI with idle wake-up (issue #261), shaped like the Codex adapter.
 *
 * `concord adapters copilot` starts Copilot's TUI with its embedded server
 * (`--ui-server`) on a fresh loopback port and exports that address. Copilot's
 * hooks inherit it, so the session-start hook starts a detached host for the
 * session; the host resumes the session over the server and hands each Concord
 * message to it — steering a running turn, or starting one while it is idle.
 * Plain `copilot` sessions never see the address and keep hook delivery.
 */

/** Where the launcher tells hooks the session's embedded server listens. */
export const COPILOT_SERVER_ENV = 'CONCORD_COPILOT_SERVER_URL';
/** The release whose `--ui-server` protocol this adapter was verified against. */
export const COPILOT_UI_SERVER_BASELINE = [1, 0, 100] as const;

const KIND = 'copilot-cli';

/** The address the launcher exports, when this process descends from it. */
export function copilotServerAddress(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const address = env[COPILOT_SERVER_ENV]?.trim();
  return address === undefined || address === '' ? undefined : address;
}

/** The command line and environment for one launched Copilot session. */
export function copilotLaunchPlan(
  port: number,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: ['--ui-server', '--port', String(port), ...args],
    env: { ...env, [COPILOT_SERVER_ENV]: `127.0.0.1:${String(port)}` },
  };
}

/** Whether `copilot --version` output is a release this adapter supports. */
export function supportsUiServer(versionOutput: string): boolean {
  const version = versionTuple(versionOutput);
  return version !== undefined && atLeast(version, COPILOT_UI_SERVER_BASELINE);
}

/**
 * Run Copilot's TUI with its embedded server. An unverified Copilot release
 * runs plain, with hook delivery only, rather than on a protocol Concord has
 * not checked.
 */
export async function launchCopilot(args: readonly string[]): Promise<void> {
  const executable = executablePath('copilot', process.env);
  if (executable === undefined) throw new Error('Copilot CLI was not found on PATH.');
  const version = run(executable, ['--version'], process.env).output;
  let plan = { args: [...args], env: process.env };
  if (supportsUiServer(version)) {
    plan = copilotLaunchPlan(await availablePort(), args, process.env);
  } else {
    process.stderr.write(
      `Concord: idle wake-up needs Copilot CLI ${COPILOT_UI_SERVER_BASELINE.join('.')} or later ` +
        `(found "${version}"); starting Copilot with hook delivery only.\n`,
    );
  }
  const tui = spawn(executable, plan.args, { env: plan.env, stdio: 'inherit' });
  const code = await new Promise<number | null>((resolve, reject) => {
    tui.once('error', reject);
    tui.once('exit', resolve);
  });
  if (code !== null && code !== 0) process.exitCode = code;
}

/**
 * The local relay hands over a message's bare text, while hooks and the cloud
 * host frame it with its sender and id. Frame it the same way here, so Copilot
 * can tell a peer message from the user and knows which id to answer.
 */
export class FramedCopilotAdapter implements AgentSessionAdapter {
  readonly provider = KIND;

  constructor(private readonly session: PushPromptSession) {}

  isBusy(): boolean {
    return this.session.isBusy();
  }

  steer(delivery: AgentSessionDelivery): Promise<string | undefined> {
    return this.session.pushPrompt(frame(delivery), 'steer');
  }

  inject(delivery: AgentSessionDelivery): Promise<string | undefined> {
    return this.session.pushPrompt(frame(delivery), 'inject');
  }
}

function frame(delivery: AgentSessionDelivery): string {
  return renderInboxBody([
    {
      messageId: delivery.messageId,
      senderAgentId: delivery.senderAgentId,
      taskId: null,
      content: delivery.content,
      messageKind: 'prompt',
      deliveryLatencyMs: null,
    },
  ]);
}

async function connectSession(address: string, sessionId: string): Promise<CopilotUiServerClient> {
  const client = new CopilotUiServerClient(address, sessionId);
  await client.connect();
  return client;
}

/** Hosts one Copilot session's local relay until the TUI exits or the host is stopped. */
export async function hostCopilot(
  agentId: string,
  sessionId: string,
  address: string,
): Promise<void> {
  const context = openContext(process.cwd());
  ensureAgentRegistered(context.repos, { agentId, kind: KIND }, context.repoRoot);
  const client = await connectSession(address, sessionId);
  const relay = await startAgentRelay({
    repos: context.repos,
    agentId,
    address: relayAddress(context.concordPath, agentId),
    adapter: new FramedCopilotAdapter(client),
    pullFallback: true,
  });
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void relay.close().finally(() => {
        client.close();
        resolve();
      });
    };
    client.onClosed(stop);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** Hosts one Copilot session's live receiver against Concord Cloud until the TUI exits. */
export async function hostCopilotInCloud(
  runtime: CloudRuntime,
  agentId: string,
  sessionId: string,
  address: string,
): Promise<void> {
  const client = await connectSession(address, sessionId);
  // deliverToSession frames each message before handing it over.
  const adapter = new PushPromptSessionAdapter(KIND, client);
  // The TUI is gone: nothing left to deliver to, and the receiver lease lapses.
  client.onClosed(() => process.exit(0));
  try {
    await watchCloud(runtime, agentId, KIND, false, (messages, stop) =>
      deliverToSession(runtime, agentId, adapter, messages, stop),
    );
  } finally {
    client.close();
  }
}
