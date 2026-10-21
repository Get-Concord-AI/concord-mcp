import type { Command } from '@commander-js/extra-typings';
import { spawn } from 'node:child_process';

import { z } from 'zod';

import { resolveRepoRoot } from '../../config/paths.js';
import { readUserConfig } from '../../config/user-config.js';
import { harnessNames } from '../../domain/harness-config.js';
import { ensureHarnessAdapter } from '../../install/adapters/self-heal.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { relayAddress } from '../../relay/address.js';
import { CodexAppServerAdapter } from '../../relay/adapters.js';
import { CodexDaemonClient } from '../../relay/codex-client.js';
import { CodexReadTracker } from '../../relay/codex-read-tracker.js';
import { sessionKey } from '../../domain/receipts.js';
import { startAgentRelay } from '../../relay/server.js';
import {
  installGlobalAdapters,
  renderAdapterReport,
  statusGlobalAdapters,
  uninstallGlobalAdapters,
} from '../../install/adapters/index.js';
import { openContext } from '../context.js';
import { availablePort } from '../local-port.js';
import { hostCodexInCloud } from './cloud-codex.js';
import {
  copilotServerAddress,
  hostCopilot,
  hostCopilotInCloud,
  launchCopilot,
} from './copilot-adapter.js';
import { cloudAccess } from './cloud-inbox.js';

async function hostCodex(agentId: string, threadId: string): Promise<void> {
  const context = openContext(process.cwd());
  ensureAgentRegistered(context.repos, { agentId, kind: 'codex' }, context.repoRoot);
  const client = new CodexDaemonClient();
  // Read receipts: the turn that took a pushed message completed with it as input.
  const session = sessionKey(threadId);
  const reads = new CodexReadTracker(threadId, (messageIds) => {
    try {
      context.repos.agentMessages.markRead(agentId, session, messageIds, 'turn_completed');
    } catch (error) {
      process.stderr.write(
        `Concord: could not record a read receipt: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  });
  client.onNotification((method, params) => {
    reads.notify(method, params);
  });
  await client.connect();
  await client.resumeThread(threadId);
  const adapter = new CodexAppServerAdapter(client, threadId, () => client.currentTurnId(), reads);
  const relay = await startAgentRelay({
    repos: context.repos,
    agentId,
    address: relayAddress(context.concordPath, agentId),
    adapter,
    pullFallback: true,
  });
  const stop = (): void => {
    void relay.close().finally(() => {
      client.close();
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise<void>((resolve) => {
    process.once('beforeExit', () => {
      resolve();
    });
  });
}

async function waitForCodexServer(url: string, server: ReturnType<typeof spawn>): Promise<void> {
  const healthUrl = url.replace(/^ws:/u, 'http:') + '/readyz';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(
        `Codex app-server exited before it became ready (${String(server.exitCode)}).`,
      );
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // The listener may not have bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the Codex app-server to become ready.');
}

export function codexManagedEnvironment(url: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, CONCORD_CODEX_APP_SERVER_URL: url };
}

export function codexManagedLaunchContext(
  repoRoot: string,
  url: string,
  env: NodeJS.ProcessEnv,
): { cwd: string; env: NodeJS.ProcessEnv } {
  return { cwd: repoRoot, env: codexManagedEnvironment(url, env) };
}

async function launchCodex(args: readonly string[], repoRoot: string): Promise<void> {
  const port = await availablePort();
  const url = `ws://127.0.0.1:${String(port)}`;
  // The app-server, not the remote TUI, owns MCP child processes. Give both
  // processes the URL so SessionStart's detached Concord host inherits it and
  // connects back to this exact server instead of falling back to daemon proxy.
  // Codex intentionally filters the environment of MCP children, so also run
  // the complete managed tree from the resolved repository root.
  const context = codexManagedLaunchContext(repoRoot, url, process.env);
  const server = spawn('codex', ['app-server', '--listen', url], {
    ...context,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForCodexServer(url, server);
    const tui = spawn('codex', ['--remote', url, ...args], {
      ...context,
      stdio: 'inherit',
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      tui.once('error', reject);
      tui.once('exit', resolve);
    });
    if (code !== null && code !== 0) process.exitCode = code;
  } finally {
    server.kill();
  }
}

export function registerAdaptersCommand(program: Command): void {
  const adapters = program.command('adapters').description('Manage global harness adapters');
  const repoRoot = (): string => resolveRepoRoot(process.cwd(), process.env);
  adapters
    .command('install')
    .description('Install adapters into every detected harness')
    .option('--require', 'exit non-zero unless every detected adapter installs')
    .action((options) => {
      const report = installGlobalAdapters(import.meta.url, process.env, repoRoot());
      process.stdout.write(`${renderAdapterReport(report)}\n`);
      if (
        options.require === true &&
        report.some((entry) => entry.detected && entry.status !== 'installed')
      ) {
        process.exitCode = 1;
      }
    });
  adapters
    .command('status')
    .description('Show detection, installation, and delivery capability by harness')
    .action(() => {
      process.stdout.write(
        `${renderAdapterReport(statusGlobalAdapters(process.env, repoRoot()))}\n`,
      );
    });
  adapters
    .command('doctor')
    .description('Probe installed adapters and explain degraded delivery')
    .action(() => {
      process.stdout.write(
        `${renderAdapterReport(statusGlobalAdapters(process.env, repoRoot()))}\n`,
      );
    });
  adapters
    .command('uninstall')
    .description('Remove only globally installed Concord adapter artifacts')
    .action(() => {
      process.stdout.write(`${renderAdapterReport(uninstallGlobalAdapters(process.env))}\n`);
    });
  adapters
    .command('ensure', { hidden: true })
    .description("Check one harness's adapter; install or repair it if the user opted in")
    .argument('<harness>', 'Harness to check')
    .action((harness) => {
      const parsed = z.enum(harnessNames).safeParse(harness);
      if (!parsed.success) throw new Error(`Unknown harness: ${harness}`);
      const result = ensureHarnessAdapter(parsed.data, {
        moduleUrl: import.meta.url,
        env: process.env,
        autoAdapters: readUserConfig(process.env).autoAdapters === true,
        repoRoot: repoRoot(),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });
  adapters
    .command('codex')
    .description('Launch Codex through a Concord-reachable local app-server')
    .argument('[args...]', 'Arguments forwarded to the Codex TUI')
    .action(async (args) => launchCodex(args, repoRoot()));
  adapters
    .command('copilot')
    .description('Launch Copilot CLI with idle wake-up through its local embedded server')
    .argument('[args...]', 'Arguments forwarded to the Copilot TUI')
    // Copilot's own flags (-i, --allow-tool, ...) are forwarded, not parsed here.
    .allowUnknownOption()
    .action(async (args) => launchCopilot(args));
  adapters
    .command('host-copilot', { hidden: true })
    .requiredOption('--agent <id>')
    .requiredOption('--session <id>')
    .option('--server <address>', "Embedded server address; defaults to the launcher's")
    .action(async (options) => {
      const address = options.server ?? copilotServerAddress();
      if (address === undefined) throw new Error('No Copilot embedded server address.');
      const access = cloudAccess(process.cwd());
      if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
      if (access.kind === 'cloud') {
        await hostCopilotInCloud(access.runtime, options.agent, options.session, address);
        return;
      }
      await hostCopilot(options.agent, options.session, address);
    });
  adapters
    .command('host-codex', { hidden: true })
    .requiredOption('--agent <id>')
    .requiredOption('--thread <id>')
    .action(async (options) => {
      const access = cloudAccess(process.cwd());
      if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
      if (access.kind === 'cloud') {
        await hostCodexInCloud(access.runtime, options.agent, options.thread);
        return;
      }
      await hostCodex(options.agent, options.thread);
    });
}
