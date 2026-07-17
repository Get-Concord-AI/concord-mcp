import { dirname } from 'node:path';

import type { TaskRecord } from '../db/index.js';

/** The declared surface of a task, used to compare against other tasks. */
export interface OverlapSurface {
  taskId: string;
  expectedFiles: readonly string[];
  modules: readonly string[];
  domains: readonly string[];
  riskTags: readonly string[];
}

/** A flagged overlap between a candidate task and one existing task. */
export interface OverlapWarning {
  taskId: string;
  title: string;
  reasons: string[];
}

function sortedIntersection(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  const shared = new Set(a.filter((value) => other.has(value)));
  return [...shared].sort((x, y) => x.localeCompare(y));
}

function directories(files: readonly string[]): string[] {
  return files.map((file) => dirname(file)).filter((dir) => dir !== '.' && dir !== '');
}

function surfaceOf(task: TaskRecord): OverlapSurface {
  return {
    taskId: task.taskId,
    expectedFiles: task.expectedFiles,
    modules: task.modules,
    domains: task.domains,
    riskTags: task.riskTags,
  };
}

function reasonsFor(candidate: OverlapSurface, existing: OverlapSurface): string[] {
  const reasons: string[] = [];

  const sameFiles = sortedIntersection(candidate.expectedFiles, existing.expectedFiles);
  if (sameFiles.length > 0) {
    reasons.push(`same file(s): ${sameFiles.join(', ')}`);
  }

  const sameDirs = sortedIntersection(
    directories(candidate.expectedFiles),
    directories(existing.expectedFiles),
  );
  if (sameDirs.length > 0 && sameFiles.length === 0) {
    reasons.push(`same directory: ${sameDirs.join(', ')}`);
  }

  const sameModules = sortedIntersection(candidate.modules, existing.modules);
  if (sameModules.length > 0) {
    reasons.push(`shared module(s): ${sameModules.join(', ')}`);
  }

  const sameDomains = sortedIntersection(candidate.domains, existing.domains);
  if (sameDomains.length > 0) {
    reasons.push(`shared domain(s): ${sameDomains.join(', ')}`);
  }

  const sameRiskTags = sortedIntersection(candidate.riskTags, existing.riskTags);
  if (sameRiskTags.length > 0) {
    reasons.push(`shared risk tag(s): ${sameRiskTags.join(', ')}`);
  }

  return reasons;
}

/**
 * Flag obvious overlaps between the candidate surface and existing tasks, based
 * on declared files, directories, modules, domains, and risk tags. This is a
 * deliberately naive v0: it does not perform semantic conflict detection.
 */
export function detectOverlaps(
  candidate: OverlapSurface,
  existing: readonly TaskRecord[],
): OverlapWarning[] {
  const warnings: OverlapWarning[] = [];
  for (const task of existing) {
    if (task.taskId === candidate.taskId) {
      continue;
    }
    const reasons = reasonsFor(candidate, surfaceOf(task));
    if (reasons.length > 0) {
      warnings.push({ taskId: task.taskId, title: task.title, reasons });
    }
  }
  return warnings;
}
