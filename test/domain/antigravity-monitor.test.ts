import { describe, expect, it } from 'vitest';

import {
  antigravityInjectSteps,
  antigravityMonitorCommand,
  antigravityMonitorNudge,
} from '../../src/domain/antigravity-monitor.js';

const FIRST_CALL = JSON.stringify({ conversationId: 'conv-1', invocationNum: 0 });

describe('antigravityMonitorNudge', () => {
  it('asks for the monitor on the first model call of a turn when nothing is watching', () => {
    const nudge = antigravityMonitorNudge(FIRST_CALL, 'antigravity:abcd1234', false);
    expect(nudge).toContain(
      '`concord inbox watch --agent antigravity:abcd1234 --provider antigravity --once`',
    );
    expect(nudge).toContain('background command');
  });

  it('stays quiet while a monitor is watching', () => {
    expect(antigravityMonitorNudge(FIRST_CALL, 'antigravity:abcd1234', true)).toBeUndefined();
  });

  it('asks only once per turn, not on later model calls', () => {
    const later = JSON.stringify({ conversationId: 'conv-1', invocationNum: 1 });
    expect(antigravityMonitorNudge(later, 'antigravity:abcd1234', false)).toBeUndefined();
  });

  it('stays quiet on payloads without an invocation number or that are not JSON', () => {
    const bare = JSON.stringify({ conversationId: 'conv-1' });
    expect(antigravityMonitorNudge(bare, 'antigravity:abcd1234', false)).toBeUndefined();
    expect(antigravityMonitorNudge('not json', 'antigravity:abcd1234', false)).toBeUndefined();
  });
});

describe('antigravityInjectSteps', () => {
  it('is empty with no messages and no nudge', () => {
    expect(antigravityInjectSteps([], undefined)).toEqual([]);
  });

  it('carries the nudge as a user step', () => {
    const nudge = `start ${antigravityMonitorCommand('antigravity:abcd1234')}`;
    expect(antigravityInjectSteps([], nudge)).toEqual([{ userMessage: nudge }]);
  });
});
