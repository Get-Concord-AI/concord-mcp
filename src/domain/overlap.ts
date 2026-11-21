import { isAbsolute, posix, sep, win32 } from 'node:path';

import type { TaskRecord, TaskStatus } from '../db/index.js';

/**
 * Statuses in which a task still owns its declared scope: someone is working on
 * it or is about to (an assignee who has not started, a pending handoff
 * recipient). Claim-time and edit-time overlap checks both compare against
 * these, so they agree on what counts as a collision.
 */
export const CLAIMED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'assigned',
  'active',
  'blocked',
  'handoff_offered',
]);

/** The declared surface of a task, used to compare against other tasks. */
export interface OverlapSurface {
  taskId: string;
  expectedFiles: readonly string[];
  modules: readonly string[];
  domains: readonly string[];
  riskTags: readonly string[];
  /** Parent task, if this is a subtask. A task never overlaps its own parent or
   * child (their shared surface is expected). */
  parentTaskId?: string | null;
}

/** A flagged overlap between a candidate task and one existing task. */
export interface OverlapWarning {
  taskId: string;
  title: string;
  reasons: string[];
  kinds: OverlapKind[];
}

export type OverlapKind =
  'same_file' | 'same_directory' | 'shared_module' | 'shared_domain' | 'shared_risk_tag';

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
export function normalizePath(file: string): string {
  const unified = file.trim().replaceAll('\\', '/');
  const normalized = posix.normalize(unified).replace(/^\.\//, '').replace(/\/$/, '');
  return normalized === '.' ? '' : normalized;
}

/** Recognize explicit repo-root claims before file normalization drops them. */
export function isRootClaim(entry: string): boolean {
  const trimmed = entry.trim();
  return trimmed === '.' || trimmed === './' || trimmed === '/';
}

function normalizeClaimEntry(entry: string): string {
  return isRootClaim(entry) ? '.' : normalizePath(entry);
}

/** True when `outer` is a strict ancestor directory of `inner`. Both must be
 * normalized. Matches whole path segments, so `src/app` does not contain
 * `src/application/x.ts`. For root claims, absolute paths must have a
 * checkout-relative value supplied by the caller. */
function containsPath(
  outer: string,
  inner: string,
  pathsFromCheckout: ReadonlyMap<string, string> | undefined,
): boolean {
  if (outer === '.') {
    let fromRoot: string | undefined = inner;
    if (isAbsolute(inner)) {
      fromRoot = pathsFromCheckout?.get(inner);
    } else if (win32.isAbsolute(inner) || (sep === '\\' && win32.parse(inner).root !== '')) {
      // Windows absolute paths on POSIX and drive-relative paths on Windows
      // cannot be resolved within the checkout.
      return false;
    }
    return (
      fromRoot !== undefined &&
      fromRoot !== '' &&
      fromRoot !== '.' &&
      fromRoot !== '..' &&
      !fromRoot.startsWith('../') &&
      !isAbsolute(fromRoot)
    );
  }
  return outer !== '' && inner.startsWith(`${outer}/`);
}

/** Pairs where one declared entry is a directory containing the other, as
 * `dir -> path`. A file and a directory cannot share a path, so any entry that
 * is a strict path prefix of another is a directory claim. */
function containedPairs(
  a: readonly string[],
  b: readonly string[],
  pathsFromCheckout: ReadonlyMap<string, string> | undefined,
): string[] {
  const left = [...new Set(a.map(normalizeClaimEntry).filter((file) => file !== ''))];
  const right = [...new Set(b.map(normalizeClaimEntry).filter((file) => file !== ''))];
  const pairs = new Set<string>();
  for (const x of left) {
    for (const y of right) {
      if (containsPath(x, y, pathsFromCheckout)) {
        pairs.add(`${x} -> ${y}`);
      } else if (containsPath(y, x, pathsFromCheckout)) {
        pairs.add(`${y} -> ${x}`);
      }
    }
  }
  return [...pairs].sort((p, q) => p.localeCompare(q));
}

/** True when a declared entry equals the file or is a directory containing it. */
export function entryCoversFile(
  entry: string,
  file: string,
  pathsFromCheckout?: ReadonlyMap<string, string>,
): boolean {
  const normalizedEntry = normalizeClaimEntry(entry);
  const normalizedFile = normalizePath(file);
  return (
    normalizedEntry !== '' &&
    (normalizedEntry === normalizedFile ||
      containsPath(normalizedEntry, normalizedFile, pathsFromCheckout))
  );
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
    parentTaskId: task.parentTaskId,
  };
}

/** True when the two tasks are in a direct parent/child relationship. */
function isParentChild(candidate: OverlapSurface, task: TaskRecord): boolean {
  return candidate.parentTaskId === task.taskId || task.parentTaskId === candidate.taskId;
}

function detailsFor(
  candidate: OverlapSurface,
  existing: OverlapSurface,
  pathsFromCheckout: ReadonlyMap<string, string> | undefined,
): { reasons: string[]; kinds: OverlapKind[] } {
  const reasons: string[] = [];
  const kinds: OverlapKind[] = [];

  const sameFiles = sortedIntersection(
    candidate.expectedFiles.map(normalizePath).filter((file) => file !== ''),
    existing.expectedFiles.map(normalizePath).filter((file) => file !== ''),
  );
  if (sameFiles.length > 0) {
    reasons.push(`same file(s): ${sameFiles.join(', ')}`);
  }

  const nested = containedPairs(candidate.expectedFiles, existing.expectedFiles, pathsFromCheckout);
  if (nested.length > 0) {
    reasons.push(`directory claim covers file(s): ${nested.join(', ')}`);
  }

  if (sameFiles.length > 0 || nested.length > 0) {
    kinds.push('same_file');
  } else {
    const sameDirs = sortedIntersection(
      directories(candidate.expectedFiles),
      directories(existing.expectedFiles),
    );
    if (sameDirs.length > 0) {
      reasons.push(`same directory: ${sameDirs.join(', ')}`);
      kinds.push('same_directory');
    }
  }

  const sameModules = sortedIntersection(tokensOf(candidate.modules), tokensOf(existing.modules));
  if (sameModules.length > 0) {
    reasons.push(`shared module(s): ${sameModules.join(', ')}`);
    kinds.push('shared_module');
  }

  const sameDomains = sortedIntersection(tokensOf(candidate.domains), tokensOf(existing.domains));
  if (sameDomains.length > 0) {
    reasons.push(`shared domain(s): ${sameDomains.join(', ')}`);
    kinds.push('shared_domain');
  }

  const sameRiskTags = sortedIntersection(
    tokensOf(candidate.riskTags),
    tokensOf(existing.riskTags),
  );
  if (sameRiskTags.length > 0) {
    reasons.push(`shared risk tag(s): ${sameRiskTags.join(', ')}`);
    kinds.push('shared_risk_tag');
  }

  return { reasons, kinds };
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
  startIndex = 0,
  pathsFromCheckout?: ReadonlyMap<string, string>,
): OverlapWarning[] {
  const warnings: OverlapWarning[] = [];
  for (let index = startIndex; index < existing.length; index += 1) {
    const task = existing[index];
    if (task === undefined || task.taskId === candidate.taskId || isParentChild(candidate, task)) {
      continue;
    }
    const { reasons, kinds } = detailsFor(candidate, surfaceOf(task), pathsFromCheckout);
    if (reasons.length > 0) {
      warnings.push({ taskId: task.taskId, title: task.title, reasons, kinds });
    }
  }
  return warnings;
}
