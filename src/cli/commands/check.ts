import type { Command } from '@commander-js/extra-typings';

import type { Repositories } from '../../db/index.js';
import { normalizePath, type OverlapWarning } from '../../domain/overlap.js';
import { openContext } from '../context.js';

/**
 * Exact-file collisions between the given files and OTHER active tasks' declared
 * files. This is the client-agnostic primitive behind edit-time enforcement: a
 * PreToolUse hook (Claude Code), a git pre-commit hook, or CI can call it to
 * find out whether the files about to change are already claimed by someone
 * else. `selfTaskId` excludes your own claim so you are not flagged against
 * yourself.
 *
 * Unlike claim-time overlap detection (which also warns on shared
 * directories/modules/domains), this gate is intentionally precise: it fires
 * only on the *same file*, since blocking an edit on a coarse signal like a
 * shared top-level directory would be too noisy to be useful.
 */
export function checkFileOverlaps(
  repos: Repositories,
  files: readonly string[],
  selfTaskId?: string,
): OverlapWarning[] {
  const wanted = new Set(files.map(normalizePath).filter((file) => file !== ''));
  const warnings: OverlapWarning[] = [];
  for (const task of repos.tasks.list()) {
    if (task.status !== 'active' || task.taskId === selfTaskId) {
      continue;
    }
    const shared = task.expectedFiles.map(normalizePath).filter((file) => wanted.has(file));
    if (shared.length > 0) {
      const unique = [...new Set(shared)].sort((a, b) => a.localeCompare(b));
      warnings.push({
        taskId: task.taskId,
        title: task.title,
        reasons: [`same file(s): ${unique.join(', ')}`],
      });
    }
  }
  return warnings;
}

/** Human-readable result for `concord check`. */
export function renderCheck(files: readonly string[], overlaps: readonly OverlapWarning[]): string {
  if (files.length === 0) {
    return 'No files to check. Usage: concord check [--task <id>] <file>...';
  }
  if (overlaps.length === 0) {
    return `OK: none of the ${String(files.length)} file(s) overlap another active task.`;
  }
  const lines = [
    `Overlap: files you are about to edit collide with ${String(overlaps.length)} active task(s):`,
  ];
  for (const overlap of overlaps) {
    lines.push(`  - ${overlap.taskId} (${overlap.title}): ${overlap.reasons.join('; ')}`);
  }
  return lines.join('\n');
}

export function registerCheckCommand(program: Command): void {
  program
    .command('check [files...]')
    .description(
      'Check whether files you are about to edit overlap another active task (for hooks/CI)',
    )
    .option('-t, --task <id>', "your own task id, so its own claim isn't flagged as an overlap")
    .action((files, options) => {
      const overlaps = checkFileOverlaps(openContext(process.cwd()).repos, files, options.task);
      process.stdout.write(`${renderCheck(files, overlaps)}\n`);
      if (overlaps.length > 0) {
        // Non-zero so a hook/CI can block. Claude Code PreToolUse hooks treat
        // exit code 2 as "deny"; wrap as `concord check ... || exit 2` there.
        process.exitCode = 1;
      }
    });
}
