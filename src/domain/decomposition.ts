/**
 * Advisory checks that nudge agents to break work into the smallest
 * independently-handoffable unit. A single claim that spans many files,
 * modules, or domains tends to be too big to hand off or review cleanly, and it
 * produces coarse overlap signals. These thresholds are soft: exceeding them is
 * a suggestion, never an error.
 */

/** Soft upper bounds above which a claim looks too broad. */
export const CLAIM_BREADTH_LIMITS = {
  expectedFiles: 5,
  modules: 3,
  domains: 2,
} as const;

/** The parts of a claim used to judge whether it is too broad. */
export interface ClaimBreadthInput {
  expectedFiles: readonly string[];
  modules: readonly string[];
  domains: readonly string[];
}

/**
 * Return human-readable reasons a claim looks too broad, or `[]` if it is
 * appropriately scoped. Non-blocking: callers surface this as a suggestion to
 * split the work, not as a rejection.
 */
export function assessClaimBreadth(input: ClaimBreadthInput): string[] {
  const reasons: string[] = [];

  if (input.expectedFiles.length > CLAIM_BREADTH_LIMITS.expectedFiles) {
    reasons.push(
      `${String(input.expectedFiles.length)} expected files (recommended <= ${String(CLAIM_BREADTH_LIMITS.expectedFiles)})`,
    );
  }
  if (input.modules.length > CLAIM_BREADTH_LIMITS.modules) {
    reasons.push(
      `${String(input.modules.length)} modules (recommended <= ${String(CLAIM_BREADTH_LIMITS.modules)})`,
    );
  }
  if (input.domains.length > CLAIM_BREADTH_LIMITS.domains) {
    reasons.push(
      `${String(input.domains.length)} domains (recommended <= ${String(CLAIM_BREADTH_LIMITS.domains)})`,
    );
  }

  return reasons;
}
