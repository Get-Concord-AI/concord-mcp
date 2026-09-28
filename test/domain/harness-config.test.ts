import { describe, expect, it } from 'vitest';

import {
  HARNESS_CONFIGS,
  configuredMonitorCapabilityFor,
  harnessNames,
  renderHarnessMonitorInstructions,
} from '../../src/domain/harness-config.js';

describe('harness configuration', () => {
  it('defines every supported harness in one catalog', () => {
    expect(Object.keys(HARNESS_CONFIGS)).toEqual(harnessNames);
  });

  it('gives each verified monitor idle reachability', () => {
    for (const config of Object.values(HARNESS_CONFIGS)) {
      if (!config.monitor.verified) continue;
      expect(configuredMonitorCapabilityFor(config.name).reach).toContain('idle');
    }
  });

  it('uses harness-owned background execution for Cursor, Gemini, and Grok', () => {
    expect(HARNESS_CONFIGS.cursor.monitor).toMatchObject({
      lifecycle: 'one-shot',
      background: true,
      command: 'concord inbox watch --provider cursor --once',
    });
    expect(HARNESS_CONFIGS.gemini.monitor).toMatchObject({
      lifecycle: 'one-shot',
      completion: 'shell-inject',
      background: true,
    });
    expect(HARNESS_CONFIGS.grok.monitor).toMatchObject({
      lifecycle: 'persistent',
      background: true,
      command: 'concord inbox watch --provider grok',
    });
  });

  it('does not mistake a bare Codex background terminal for idle delivery', () => {
    expect(HARNESS_CONFIGS.codex.monitor.backgroundShell).toEqual({
      supported: true,
      completionStartsTurn: false,
    });
    expect(HARNESS_CONFIGS.codex.monitor.lifecycle).toBe('managed');
    expect(HARNESS_CONFIGS.codex.monitor.completion).toBe('controller');
  });

  it('renders guidance from the configured commands', () => {
    const guidance = renderHarnessMonitorInstructions();
    expect(guidance).toContain(HARNESS_CONFIGS.cursor.monitor.command);
    expect(guidance).toContain(HARNESS_CONFIGS.gemini.monitor.command);
    expect(guidance).toContain(HARNESS_CONFIGS.grok.monitor.command);
  });
});
