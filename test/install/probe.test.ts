import { describe, expect, it } from 'vitest';

import { versionTuple } from '../../src/install/adapters/probe.js';

describe('versionTuple', () => {
  it.each([
    ['2.1.4', [2, 1, 4]],
    ['codex-cli 0.55.0', [0, 55, 0]],
    ['Version: 1.0.12 (abc123)', [1, 0, 12]],
    // OpenCode 2 prints a `v` prefix, which `\b` alone does not separate from the digits.
    ['opencode v2.2.7', [2, 2, 7]],
    ['v1.19.5', [1, 19, 5]],
  ])('reads %j', (output, expected) => {
    expect(versionTuple(output)).toEqual(expected);
  });

  it.each(['no version here', 'build1.2.3'])('rejects %j', (output) => {
    expect(versionTuple(output)).toBeUndefined();
  });
});
