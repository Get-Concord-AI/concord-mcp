import { describe, expect, it } from 'vitest';

import {
  adapterNotice,
  monitorCommandFor,
  startBackgroundAdapterCheck,
  type AdapterCheckRunner,
} from '../../src/adapter-check.js';
import { HARNESS_CONFIGS } from '../../src/domain/harness-config.js';
import type { AgentIdentity } from '../../src/domain/identity.js';

const GROK: AgentIdentity = { agentId: 'grok:1094f0e0', kind: 'grok', origin: 'session' };

describe('adapter notices', () => {
  it('says nothing about a healthy adapter', () => {
    expect(
      adapterNotice({ harness: 'grok', outcome: 'healthy', detail: 'ok' }, GROK.agentId),
    ).toBeUndefined();
  });

  it("gives an unrepaired session its id, the fix, and its harness's monitor command", () => {
    const notice = adapterNotice(
      { harness: 'grok', outcome: 'needs_install', detail: 'The Grok plugin is not installed.' },
      GROK.agentId,
    );
    expect(notice?.monitorCommand).toBe(
      HARNESS_CONFIGS.grok.monitor.command?.replace('<agent-id>', GROK.agentId),
    );
    expect(notice?.text).toContain('`concord adapters install`');
    expect(notice?.text).toContain('agent `grok:1094f0e0`');
  });

  it("falls back to the plugin monitor's watcher for Claude Code", () => {
    expect(monitorCommandFor('claude-code', 'claude-code:4f2a91c7')).toBe(
      'concord inbox watch --agent claude-code:4f2a91c7 --provider claude-code',
    );
    expect(monitorCommandFor('codex', 'codex:4f2a91c7')).toBeNull();
  });
});

describe('startBackgroundAdapterCheck', () => {
  it("checks the launching harness and exposes the notice once it's done", async () => {
    const checked: string[] = [];
    const run: AdapterCheckRunner = (harness) => {
      checked.push(harness);
      return Promise.resolve({ harness, outcome: 'repaired', detail: 'installed' });
    };
    const check = startBackgroundAdapterCheck(GROK, {}, run);
    await check.done;
    expect(checked).toEqual(['grok']);
    expect(check.getNotice()?.text).toContain('Concord installed its grok adapter');
  });

  it('does nothing for a session it cannot place in a known harness', async () => {
    let ran = false;
    const run: AdapterCheckRunner = () => {
      ran = true;
      return Promise.resolve(undefined);
    };
    const operator: AgentIdentity = { agentId: 'alpha', kind: 'unknown', origin: 'operator' };
    await startBackgroundAdapterCheck(operator, {}, run).done;
    await startBackgroundAdapterCheck(undefined, {}, run).done;
    expect(ran).toBe(false);
  });
});
