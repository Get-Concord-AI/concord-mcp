import { describe, expect, it } from 'vitest';

import { operationOutcome } from '../../src/cli/operation-outcome.js';

describe('operationOutcome', () => {
  it('keeps commands that exited cleanly successful', () => {
    expect(operationOutcome(undefined)).toBe('success');
    expect(operationOutcome(0)).toBe('success');
    expect(operationOutcome('0')).toBe('success');
  });

  it('records a failing process.exitCode as an error', () => {
    expect(operationOutcome(1)).toBe('error');
    expect(operationOutcome('1')).toBe('error');
  });
});
