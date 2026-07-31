import type { Command } from '@commander-js/extra-typings';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { writeArtifacts } from '../../artifacts/index.js';
import { concordDir, resolveRepoRoot } from '../../config/paths.js';
import {
  detectCommunicationProviders,
  readAgentCommunicationConfig,
  writeAgentCommunicationConfig,
  type CommunicationProvider,
} from '../../install/agent-communications.js';
import { installClaudeHook } from '../../install/claude-hooks.js';
import { installCodexMcpConfig } from '../../install/codex-config.js';
import { installConcord } from '../../install/index.js';
import { McpConfigParseError, installMcpConfigs } from '../../install/mcp-config.js';
import { openContext } from '../context.js';

const CONCORD_GITIGNORE_ENTRY = '.concord/';

export interface SetupOptions {
  claudeHooks?: boolean;
  mcp?: boolean;
  agentCommunications?: boolean;
  communicationProviders?: readonly CommunicationProvider[];
  env?: NodeJS.ProcessEnv;
}

export interface SetupResult {
  repoRoot: string;
  workspaceId: string;
  concordPath: string;
  written: string[];
  communicationProviders: CommunicationProvider[];
}

/** Ensure Concord's generated workspace is ignored without changing other rules. */
export function ensureConcordIgnored(repoRoot: string): void {
  const gitignorePath = join(repoRoot, '.gitignore');
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const entries = current.split(/\r?\n/u).map((line) => line.trim());
  if (entries.includes(CONCORD_GITIGNORE_ENTRY)) {
    return;
  }

  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${current}${separator}${CONCORD_GITIGNORE_ENTRY}\n`);
}

/** Set up one repository completely: state, instructions, and client registration. */
export function runSetup(cwd: string, options: SetupOptions = {}): SetupResult {
  const env = options.env ?? process.env;
  const ctx = openContext(cwd, env);

  ensureConcordIgnored(ctx.repoRoot);
  writeArtifacts(ctx.concordPath, ctx.repos);

  const written = installConcord(ctx.repoRoot);
  if (options.claudeHooks === true) {
    written.push(installClaudeHook(ctx.repoRoot));
  }
  if (options.mcp !== false) {
    written.push(...installMcpConfigs(ctx.repoRoot));
    written.push(installCodexMcpConfig(env));
  }
  const communicationProviders =
    options.communicationProviders === undefined
      ? detectCommunicationProviders(ctx.repoRoot, env)
      : [...options.communicationProviders];
  if (options.agentCommunications !== undefined) {
    written.push(
      writeAgentCommunicationConfig(
        ctx.concordPath,
        options.agentCommunications,
        communicationProviders,
      ),
    );
  }

  return {
    repoRoot: ctx.repoRoot,
    workspaceId: ctx.workspaceId,
    concordPath: ctx.concordPath,
    written,
    communicationProviders,
  };
}

async function askToInstallAgentCommunications(providers: readonly string[]): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `Enable live inter-agent prompting for detected clients (${providers.join(', ')})? [Y/n] `,
    );
    return !['n', 'no'].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
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
    .option(
      '--agent-comms',
      'approve and install the local live-prompt relay integration without prompting',
    )
    .action(async (options) => {
      try {
        const setupOptions: SetupOptions = { mcp: options.mcp };
        if (options.claudeHooks === true) {
          setupOptions.claudeHooks = true;
        }
        const repoRoot = resolveRepoRoot(process.cwd(), process.env);
        const concordPath = concordDir(repoRoot);
        const detected = detectCommunicationProviders(repoRoot);
        if (options.agentComms === true) {
          setupOptions.agentCommunications = true;
          setupOptions.communicationProviders = detected;
        } else if (
          process.stdin.isTTY &&
          process.stdout.isTTY &&
          detected.length > 0 &&
          readAgentCommunicationConfig(concordPath) === undefined
        ) {
          setupOptions.agentCommunications = await askToInstallAgentCommunications(detected);
          setupOptions.communicationProviders = detected;
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
        if (options.claudeHooks === true) {
          process.stdout.write(
            'PreToolUse hook installed. Set CONCORD_TASK=<your task id> so it excludes your own claim.\n',
          );
        }
        if (options.mcp) {
          process.stdout.write(
            'Restart your coding client so it reloads the project MCP server.\n',
          );
        }
        if (setupOptions.agentCommunications === true) {
          process.stdout.write(
            `Live prompting approved for: ${result.communicationProviders.join(', ')}. Existing sessions must be restarted once.\n`,
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
