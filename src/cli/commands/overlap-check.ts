import type { Repositories } from '../../db/index.js';
import { CLAIMED_STATUSES, normalizePath, type OverlapWarning } from '../../domain/overlap.js';

/** Exact-file collisions between the given files and other active tasks. */
export function checkFileOverlaps(
  repos: Repositories,
  files: readonly string[],
  selfTaskId?: string,
): OverlapWarning[] {
  const wanted = new Set(files.map(normalizePath).filter((file) => file !== ''));
  const warnings: OverlapWarning[] = [];
  for (const task of repos.tasks.list()) {
    if (!CLAIMED_STATUSES.has(task.status) || task.taskId === selfTaskId) continue;
    const shared = task.expectedFiles.map(normalizePath).filter((file) => wanted.has(file));
    if (shared.length > 0) {
      const unique = [...new Set(shared)].sort((a, b) => a.localeCompare(b));
      warnings.push({
        taskId: task.taskId,
        title: task.title,
        reasons: [`same file(s): ${unique.join(', ')}`],
        kinds: ['same_file'],
      });
    }
  }
  return warnings;
}
