import { posix } from 'node:path';

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

/**
 * Split a label (domain, module, risk tag) into normalized word tokens so that
 * phrasing differences do not hide a real overlap: case, surrounding
 * whitespace, and word separators (`-`, `_`, `/`, spaces) are all ignored.
 * e.g. "Todo Frontend", "todo-frontend", and ["frontend", "todo"] all share the
 * tokens {frontend, todo}.
 */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** The deduplicated set of word tokens across a list of labels. */
function tokensOf(values: readonly string[]): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of tokenize(value)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

/** Normalize a declared file path: drop a leading `./`, collapse `//`, resolve
 * `.`/`..` segments, and strip a trailing slash, so `./app/page.tsx` and
 * `app/page.tsx` compare equal. Paths stay case-sensitive. */
function normalizePath(file: string): string {
  const trimmed = file.trim().replace(/^\.\//, '');
  const normalized = posix.normalize(trimmed).replace(/\/$/, '');
  return normalized === '.' ? '' : normalized;
}

function directories(files: readonly string[]): string[] {
  return files
    .map((file) => normalizePath(file))
    .filter((file) => file !== '')
    .map((file) => posix.dirname(file))
    .filter((dir) => dir !== '.' && dir !== '');
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

  const sameFiles = sortedIntersection(
    candidate.expectedFiles.map(normalizePath).filter((file) => file !== ''),
    existing.expectedFiles.map(normalizePath).filter((file) => file !== ''),
  );
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

  const sameModules = sortedIntersection(tokensOf(candidate.modules), tokensOf(existing.modules));
  if (sameModules.length > 0) {
    reasons.push(`shared module(s): ${sameModules.join(', ')}`);
  }

  const sameDomains = sortedIntersection(tokensOf(candidate.domains), tokensOf(existing.domains));
  if (sameDomains.length > 0) {
    reasons.push(`shared domain(s): ${sameDomains.join(', ')}`);
  }

  const sameRiskTags = sortedIntersection(
    tokensOf(candidate.riskTags),
    tokensOf(existing.riskTags),
  );
  if (sameRiskTags.length > 0) {
    reasons.push(`shared risk tag(s): ${sameRiskTags.join(', ')}`);
  }

  return reasons;
}

/**
 * Flag obvious overlaps between the candidate surface and existing tasks, based
 * on declared files, directories, modules, domains, and risk tags. Labels are
 * compared by normalized word tokens (case-, separator-, and order-insensitive)
 * and files by normalized path, so phrasing differences do not hide an overlap.
 * This remains deliberately naive: no stemming or semantic conflict detection.
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
