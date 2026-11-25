import type { Repositories } from '../../db/index.js';
import {
  CLAIMED_STATUSES,
  entryCoversFile,
  normalizePath,
  pathKey,
  type OverlapPathOptions,
  type OverlapWarning,
} from '../../domain/overlap.js';
import { pathFromCheckout, resolvePathsFromCheckout } from '../../workspaces/overlap-paths.js';

/**
 * Collisions between the given files and OTHER active tasks' claimed paths.
 * This is the client-agnostic primitive behind edit-time enforcement: a
 * PreToolUse hook (Claude Code), a git pre-commit hook, or CI can call it to
 * find out whether the files about to change are already claimed by someone
 * else. `selfTaskId` excludes your own claim so you are not flagged against
 * yourself.
 *
 * Unlike claim-time overlap detection (which also warns on shared
 * directories/modules/domains), this gate fires only for files claimed
 * directly or through a directory claim. Paths compare case-insensitively when
 * `options.platform` is win32 or darwin; callers pass `process.platform`.
 */
export function checkFileOverlaps(
  repos: Repositories,
  files: readonly string[],
  selfTaskId?: string,
  options: Pick<OverlapPathOptions, 'platform'> = {},
): OverlapWarning[] {
  const { platform } = options;
  const byKey = new Map<string, string>();
  // Harnesses send absolute paths (Claude Code's Edit always does) while
  // claims are checkout-relative, so name each file the way claims do.
  const named = files.map((file) => pathFromCheckout(repos.checkoutRoot, file));
  for (const file of named.map(normalizePath)) {
    const key = pathKey(file, platform);
    if (file !== '' && !byKey.has(key)) byKey.set(key, file);
  }
  const wanted = [...byKey.values()];
  const otherClaims = repos.tasks
    .list()
    .filter((task) => CLAIMED_STATUSES.has(task.status) && task.taskId !== selfTaskId);
  const pathsFromCheckout = resolvePathsFromCheckout(
    repos.checkoutRoot,
    otherClaims.map((task) => task.expectedFiles),
    wanted,
  );

  const warnings: OverlapWarning[] = [];
  for (const task of otherClaims) {
    const shared = task.expectedFiles
      .map(normalizePath)
      .filter((entry) => entry !== '' && byKey.has(pathKey(entry, platform)));
    const sharedKeys = new Set(shared.map((entry) => pathKey(entry, platform)));
    const covered = wanted.filter(
      (file) =>
        !sharedKeys.has(pathKey(file, platform)) &&
        task.expectedFiles.some((entry) =>
          entryCoversFile(entry, file, { platform, pathsFromCheckout }),
        ),
    );
    const reasons: string[] = [];
    if (shared.length > 0) {
      const unique = [...new Set(shared)].sort((a, b) => a.localeCompare(b));
      reasons.push(`same file(s): ${unique.join(', ')}`);
    }
    if (covered.length > 0) {
      reasons.push(
        `inside claimed directory: ${covered.sort((a, b) => a.localeCompare(b)).join(', ')}`,
      );
    }
    if (reasons.length > 0) {
      warnings.push({ taskId: task.taskId, title: task.title, reasons, kinds: ['same_file'] });
    }
  }
  return warnings;
}
