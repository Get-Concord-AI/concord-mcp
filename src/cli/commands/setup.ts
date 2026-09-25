import type { Command } from '@commander-js/extra-typings';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { writeArtifacts } from '../../artifacts/index.js';
import { installClaudeHook } from '../../install/claude-hooks.js';
import { installCodexMcpConfig } from '../../install/codex-config.js';
import { installConcord } from '../../install/index.js';
import {
  installGlobalAdapters,
  renderAdapterReport,
  type AdapterReport,
} from '../../install/adapters/index.js';
import {
  McpConfigParseError,
  installMcpConfigs,
  removeGlobalCursorConcord,
} from '../../install/mcp-config.js';
import { openContext } from '../context.js';
import { findAvailableUpdate, type AvailableUpdate } from '../../update-notifier.js';
import { VERSION } from '../../version.js';

/** Ignores everything in `.concord/`, including this file, so nothing needs committing. */
const CONCORD_GITIGNORE =
  '# Created by concord setup. Keeps the local Concord workspace untracked.\n*\n';

export interface SetupOptions {
  claudeHooks?: boolean;
  mcp?: boolean;
  adapters?: boolean;
  requireAdapters?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface SetupResult {
  repoRoot: string;
  workspaceId: string;
  concordPath: string;
  written: string[];
  adapters: AdapterReport[];
}

export interface SetupUpgradeDependencies {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  resolveUpdate?: (
    currentVersion: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<AvailableUpdate | undefined>;
  askToUpgrade?: (update: AvailableUpdate) => Promise<boolean>;
  installUpdate?: (env: NodeJS.ProcessEnv) => Promise<number>;
  write?: (message: string) => void;
}

async function askToUpgrade(update: AvailableUpdate): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `Concord ${update.currentVersion} → ${update.latestVersion} is available. ` +
        'Upgrade before setup? [y/N] ',
    );
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function installUpdate(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['install', '-g', '@concord-ai/concord-mcp@latest'], {
      env,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      reject(error);
    });
    child.once('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

/** Offer an explicit upgrade before setup writes repository or client configuration. */
export async function maybeUpgradeBeforeSetup(
  dependencies: SetupUpgradeDependencies = {},
): Promise<boolean> {
  const interactive = dependencies.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return false;

  const env = dependencies.env ?? process.env;
  const resolveUpdate = dependencies.resolveUpdate ?? findAvailableUpdate;
  const update = await resolveUpdate(VERSION, env);
  if (update === undefined) return false;

  const confirmed = await (dependencies.askToUpgrade ?? askToUpgrade)(update);
  if (!confirmed) return false;

  const exitCode = await (dependencies.installUpdate ?? installUpdate)(env);
  if (exitCode !== 0) {
    throw new Error(`Concord upgrade failed with exit code ${String(exitCode)}.`);
  }

  (dependencies.write ?? ((message) => process.stdout.write(message)))(
    `Concord upgraded to ${update.latestVersion}. Rerun concord setup to configure it.\n`,
  );
  return true;
}

/**
 * Make `.concord/` ignore itself so setup never edits the repository's shared
 * `.gitignore`. An existing file is left alone so teams can customize it.
 */
export function ensureConcordIgnored(concordPath: string): void {
  const gitignorePath = join(concordPath, '.gitignore');
  if (existsSync(gitignorePath)) return;
  mkdirSync(concordPath, { recursive: true });
  writeFileSync(gitignorePath, CONCORD_GITIGNORE);
}

/** Set up one repository completely: state, instructions, and client registration. */
export function runSetup(cwd: string, options: SetupOptions = {}): SetupResult {
  const env = options.env ?? process.env;
  const ctx = openContext(cwd, env);

  ensureConcordIgnored(ctx.concordPath);
  writeArtifacts(ctx.concordPath, ctx.repos);

  const written = installConcord(ctx.repoRoot);
  let adapters: AdapterReport[] = [];
  if (options.claudeHooks === true) {
    written.push(installClaudeHook(ctx.repoRoot));
  }
  if (options.mcp !== false) {
    written.push(...installMcpConfigs(ctx.repoRoot));
    const migratedCursorConfig = removeGlobalCursorConcord(env);
    if (migratedCursorConfig !== undefined) written.push(migratedCursorConfig);
    written.push(installCodexMcpConfig(env));
  }
  // `env` is also the unit-test/config-path seam. Avoid touching unrelated
  // real harness homes unless adapter installation was explicitly requested.
  const installAdapters = options.adapters ?? (options.mcp !== false && options.env === undefined);
  if (installAdapters) {
    adapters = installGlobalAdapters(import.meta.url, env, ctx.repoRoot);
    for (const adapter of adapters) {
      if (adapter.installedPath !== undefined) written.push(adapter.installedPath);
    }
    if (
      options.requireAdapters === true &&
      adapters.some((adapter) => adapter.detected && adapter.status !== 'installed')
    ) {
      const incomplete = adapters
        .filter((adapter) => adapter.detected && adapter.status !== 'installed')
        .map((adapter) => `${adapter.harness}:${adapter.status}`)
        .join(', ');
      throw new Error(`Required harness adapters are incomplete: ${incomplete}`);
    }
  }
  return {
    repoRoot: ctx.repoRoot,
    workspaceId: ctx.workspaceId,
    concordPath: ctx.concordPath,
    // A file touched by two installers is still one file to the reader.
    written: [...new Set(written)],
    adapters,
  };
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Set up Concord state, instructions, and MCP clients for this repository')
    .option(
      '--claude-hooks',
      'also install an opt-in Claude Code PreToolUse overlap hook into .claude/settings.json',
    )
    .option('--no-mcp', 'skip MCP client registration; write local state and instructions only')
    .option('--no-adapters', 'skip global harness adapter installation')
    .option('--require-adapters', 'fail unless every detected harness adapter is ready')
    .action(async (options) => {
      try {
        if (await maybeUpgradeBeforeSetup()) return;

        const setupOptions: SetupOptions = {
          mcp: options.mcp,
          adapters: options.adapters,
          ...(options.requireAdapters === true ? { requireAdapters: true } : {}),
        };
        if (options.claudeHooks === true) {
          setupOptions.claudeHooks = true;
        }
        const result = runSetup(process.cwd(), setupOptions);
        process.stdout.write(
          `Concord setup complete\n` +
            `  repository: ${result.repoRoot}\n` +
            `  workspace:  ${result.workspaceId}\n` +
            `  state:      ${result.concordPath}\n` +
            `  configured:\n`,
        );
        for (const path of result.written) {
          process.stdout.write(`    ${path}\n`);
        }
        if (result.adapters.length > 0) {
          process.stdout.write(`\n${renderAdapterReport(result.adapters)}\n`);
        }
        if (options.claudeHooks === true) {
          process.stdout.write(
            'PreToolUse hook installed. Set CONCORD_TASK=<your task id> so it excludes your own claim.\n',
          );
        }
        if (options.mcp) {
          process.stdout.write(
            'Restart your coding client so it reloads the project MCP server.\n' +
              'Codex: run /hooks once and trust the Concord hooks. Until you do, Codex skips ' +
              'them silently and cannot receive messages from other agents.\n',
          );
        }
      } catch (error) {
        if (!(error instanceof McpConfigParseError)) {
          throw error;
        }
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    });
}
