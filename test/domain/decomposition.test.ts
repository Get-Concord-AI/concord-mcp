import { describe, expect, it } from 'vitest';

import { assessClaimBreadth, CLAIM_BREADTH_LIMITS } from '../../src/domain/decomposition.js';

describe('assessClaimBreadth', () => {
  it('returns no reasons for a well-scoped claim', () => {
    expect(
      assessClaimBreadth({
        expectedFiles: ['src/billing/retry.ts', 'src/billing/retry.test.ts'],
        modules: ['billing'],
        domains: ['payments'],
      }),
    ).toEqual([]);
  });

  it('treats the thresholds as inclusive (at the limit is fine)', () => {
    expect(
      assessClaimBreadth({
        expectedFiles: Array.from(
          { length: CLAIM_BREADTH_LIMITS.expectedFiles },
          (_, i) => `f${String(i)}.ts`,
        ),
        modules: Array.from({ length: CLAIM_BREADTH_LIMITS.modules }, (_, i) => `m${String(i)}`),
        domains: Array.from({ length: CLAIM_BREADTH_LIMITS.domains }, (_, i) => `d${String(i)}`),
      }),
    ).toEqual([]);
  });

  it('flags too many expected files', () => {
    const reasons = assessClaimBreadth({
      expectedFiles: ['a', 'b', 'c', 'd', 'e', 'f'],
      modules: [],
      domains: [],
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('6 expected files');
    expect(reasons[0]).toContain('<= 5');
  });

  it('flags every dimension that is over its limit', () => {
    const reasons = assessClaimBreadth({
      expectedFiles: ['a', 'b', 'c', 'd', 'e', 'f'],
      modules: ['app', 'ui', 'state', 'api'],
      domains: ['frontend', 'todo', 'auth'],
    });
    expect(reasons).toHaveLength(3);
    expect(reasons.some((r) => r.includes('expected files'))).toBe(true);
    expect(reasons.some((r) => r.includes('modules'))).toBe(true);
    expect(reasons.some((r) => r.includes('domains'))).toBe(true);
  });
});
