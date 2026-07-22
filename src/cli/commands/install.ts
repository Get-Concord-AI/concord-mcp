import type { Command } from '@commander-js/extra-typings';

import { findRepoRoot } from '../../config/paths.js';
import { installClaudeHook } from '../../install/claude-hooks.js';
import { installConcord } from '../../install/index.js';

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Write Concord usage instructions into supported client configs')
    .option(
      '--claude-hooks',
      'also install an opt-in Claude Code PreToolUse overlap hook into .claude/settings.json',
    )
    .action((options) => {
      const repoRoot = findRepoRoot(process.cwd());
      const written = installConcord(repoRoot);
      if (options.claudeHooks === true) {
        written.push(installClaudeHook(repoRoot));
      }
      process.stdout.write(`Installed Concord instructions:\n`);
      for (const relPath of written) {
        process.stdout.write(`  ${relPath}\n`);
      }
      if (options.claudeHooks === true) {
        process.stdout.write(
          'PreToolUse hook installed. Set CONCORD_TASK=<your task id> so it excludes your own claim.\n',
        );
      }
    });
}
