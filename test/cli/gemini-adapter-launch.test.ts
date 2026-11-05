import { describe, expect, it } from 'vitest';

import { GEMINI_MONITOR_PROMPT, geminiLaunchPlan } from '../../src/cli/commands/gemini-adapter.js';

describe('concord adapters gemini', () => {
  it('starts Gemini with a first turn that starts the inbox monitor', () => {
    expect(geminiLaunchPlan([])).toEqual({
      args: ['-i', GEMINI_MONITOR_PROMPT],
      startsMonitor: true,
    });
  });

  it('forwards Gemini flags after the opening turn', () => {
    expect(geminiLaunchPlan(['-m', 'gemini-2.5-pro', '--approval-mode', 'auto_edit']).args).toEqual(
      ['-i', GEMINI_MONITOR_PROMPT, '-m', 'gemini-2.5-pro', '--approval-mode', 'auto_edit'],
    );
  });

  it.each([
    [['-i', 'review the diff']],
    [['--prompt-interactive', 'review the diff']],
    [['--prompt-interactive=review the diff']],
    [['-p', 'summarise']],
    [['--prompt=summarise']],
  ])("leaves the user's own prompt as given: %j", (args) => {
    expect(geminiLaunchPlan(args)).toEqual({ args, startsMonitor: false });
  });

  it('names the monitor the SessionStart hook supplies, not a command of its own', () => {
    // The hook binds the monitor to this session's agent id; the launcher must not guess it.
    expect(GEMINI_MONITOR_PROMPT).toMatch(/SessionStart hook/);
    expect(GEMINI_MONITOR_PROMPT).not.toMatch(/concord inbox watch/);
  });
});
