import { describe, expect, it } from 'vitest';

import { grokMonitorCommand, grokMonitorNudge } from '../../src/domain/grok-monitor.js';

const AGENT = 'grok:1094f0e0';

function stop(fields: Record<string, unknown>): string {
  return JSON.stringify({ hook_event_name: 'Stop', reason: 'end_turn', ...fields });
}

describe('grokMonitorNudge', () => {
  it('asks for the monitor, agent id included, when none is running', () => {
    const nudge = grokMonitorNudge(stop({ backgroundTasks: [] }), AGENT);
    expect(nudge).toContain(grokMonitorCommand(AGENT));
    expect(grokMonitorCommand(AGENT)).toBe(
      'concord inbox watch --provider grok --agent grok:1094f0e0',
    );
  });

  it('stays quiet once a Concord monitor is running', () => {
    const tasks = [
      { id: 't1', type: 'monitor', status: 'running', description: grokMonitorCommand(AGENT) },
    ];
    expect(grokMonitorNudge(stop({ backgroundTasks: tasks }), AGENT)).toBeUndefined();
  });

  it('ignores unrelated monitors', () => {
    const tasks = [{ id: 't1', type: 'monitor', status: 'running', description: 'tail -f log' }];
    expect(grokMonitorNudge(stop({ backgroundTasks: tasks }), AGENT)).toBeDefined();
  });

  it('never nudges twice in a row, inside a subagent, or at session end', () => {
    expect(grokMonitorNudge(stop({ stopHookActive: true }), AGENT)).toBeUndefined();
    expect(grokMonitorNudge(stop({ subagentType: 'explore' }), AGENT)).toBeUndefined();
    expect(grokMonitorNudge(stop({ reason: 'session_end' }), AGENT)).toBeUndefined();
  });

  it('stays quiet on a payload it cannot read', () => {
    expect(grokMonitorNudge('', AGENT)).toBeUndefined();
    expect(grokMonitorNudge('{"backgroundTasks": 3}', AGENT)).toBeUndefined();
  });
});
