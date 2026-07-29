import type { Command } from '@commander-js/extra-typings';

import { resolveRepoRoot } from '../../config/paths.js';
import { installClaudeHook } from '../../install/claude-hooks.js';
import { installCodexMcpConfig } from '../../install/codex-config.js';
import { installConcord } from '../../install/index.js';
import { McpConfigParseError, installMcpConfigs } from '../../install/mcp-config.js';

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Write Concord usage instructions and MCP registration into client configs')
    .option(
      '--claude-hooks',
      'also install an opt-in Claude Code PreToolUse overlap hook into .claude/settings.json',
    )
    .option('--no-mcp', 'skip registering the MCP server; only write the usage instructions')
    .action((options) => {
      const repoRoot = resolveRepoRoot(process.cwd(), process.env);
      const written = installConcord(repoRoot);
      if (options.claudeHooks === true) {
        written.push(installClaudeHook(repoRoot));
      }

      let mcpError: McpConfigParseError | undefined;
      if (options.mcp) {
        try {
          written.push(...installMcpConfigs(repoRoot));
          written.push(installCodexMcpConfig(process.env));
        } catch (error) {
          if (!(error instanceof McpConfigParseError)) {
            throw error;
          }
          mcpError = error;
        }
      }

      process.stdout.write(`Installed Concord instructions:\n`);
      for (const path of written) {
        process.stdout.write(`  ${path}\n`);
      }
      if (options.claudeHooks === true) {
        process.stdout.write(
          'PreToolUse hook installed. Set CONCORD_TASK=<your task id> so it excludes your own claim.\n',
        );
      }
      if (mcpError !== undefined) {
        process.stderr.write(`${mcpError.message}\n`);
        process.exitCode = 1;
      }
    });
}
