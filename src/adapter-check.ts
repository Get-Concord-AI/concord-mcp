import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { harnessConfigFor, harnessNames, type HarnessName } from './domain/harness-config.js';
import type { AgentIdentity } from './domain/identity.js';
import { adapterCheckSchema, type AdapterCheck } from './install/adapters/self-heal.js';

/** Installing a harness plugin can take a while; never hold a child longer than this. */
const ENSURE_TIMEOUT_MS = 120_000;

export interface AdapterNotice {
  readonly check: AdapterCheck;
  readonly monitorCommand: string | null;
  readonly text: string;
}

export type AdapterCheckRunner = (
  harness: HarnessName,
  env: NodeJS.ProcessEnv,
) => Promise<AdapterCheck | undefined>;

export interface BackgroundAdapterCheck {
  getNotice: () => AdapterNotice | undefined;
  done: Promise<void>;
}

/** The command that keeps a session reachable while idle, with its id filled in. */
export function monitorCommandFor(harness: HarnessName, agentId: string): string | null {
  const command = harnessConfigFor(harness)?.monitor.command;
  if (command !== undefined) return command.replace('<agent-id>', agentId);
  // Claude Code's monitor ships inside its plugin. Without the plugin, the same
  // watcher runs as an ordinary background command.
  return harness === 'claude-code'
    ? `concord inbox watch --agent ${agentId} --provider claude-code`
    : null;
}

/**
 * What to tell a session whose harness adapter was missing or broken. Plugins
 * and hooks load at session start, so even a repaired adapter only helps the
 * next session; this one learns its id and monitor command here instead.
 */
export function adapterNotice(check: AdapterCheck, agentId: string): AdapterNotice | undefined {
  if (check.outcome === 'healthy') return undefined;
  const monitorCommand = monitorCommandFor(check.harness, agentId);
  const detail = check.detail.replace(/\.$/u, '');
  const session =
    `This session started without it: it is agent \`${agentId}\`.` +
    (monitorCommand === null
      ? ''
      : ` To receive peer messages while idle, start a background monitor for \`${monitorCommand}\`.`);
  const status = {
    repaired: `Concord installed its ${check.harness} adapter; new sessions load it.`,
    needs_install:
      `Concord's ${check.harness} adapter needs attention (${detail}). Ask the user to ` +
      'run `concord adapters install` and restart this session.',
    repair_failed:
      `Concord could not repair its ${check.harness} adapter (${detail}). Ask the user ` +
      'to run `concord doctor`.',
  }[check.outcome];
  return { check, monitorCommand, text: `${status} ${session}` };
}

/** Run `concord adapters ensure` in a child so a slow harness CLI never blocks the server. */
export const runEnsureCommand: AdapterCheckRunner = (harness, env) => {
  const cli = fileURLToPath(new URL('./cli/index.js', import.meta.url));
  if (!existsSync(cli)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, 'adapters', 'ensure', harness],
      { env, timeout: ENSURE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        try {
          const raw: unknown = JSON.parse(stdout);
          const parsed = adapterCheckSchema.safeParse(raw);
          resolve(parsed.success ? parsed.data : undefined);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
};

/** Check this session's own harness adapter in the background; read the result later. */
export function startBackgroundAdapterCheck(
  identity: AgentIdentity | undefined,
  env: NodeJS.ProcessEnv = process.env,
  run: AdapterCheckRunner = runEnsureCommand,
): BackgroundAdapterCheck {
  let notice: AdapterNotice | undefined;
  const harness = harnessNames.find((name) => name === identity?.kind);
  if (identity === undefined || harness === undefined) {
    return { getNotice: () => undefined, done: Promise.resolve() };
  }
  const done = run(harness, env).then(
    (check) => {
      notice = check === undefined ? undefined : adapterNotice(check, identity.agentId);
      // MCP clients keep a server's stderr in their logs, where a user can find it.
      if (notice !== undefined) process.stderr.write(`concord-mcp: ${notice.text}\n`);
    },
    () => {
      // Adapter repair is best-effort and must never affect the server.
    },
  );
  return { getNotice: () => notice, done };
}
