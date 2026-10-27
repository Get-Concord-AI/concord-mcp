import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { DRIVEN, DRIVERS, UNDRIVEN } from './drivers/index.js';
import { claudePluginRoot } from './support/installed.js';
import { Sandbox } from './support/sandbox.js';

/**
 * `concord setup` on a clean machine with every harness present installs an
 * adapter for each, through the same commands a user's machine would run.
 */
describe('concord setup in a clean sandbox', () => {
  let sandbox: Sandbox;
  let setupOutput: string;

  beforeAll(async () => {
    sandbox = Sandbox.create('setup', inject('concordPrefix'));
    const result = await sandbox.concord(['setup'], { timeoutMs: 60_000 });
    expect(result.stderr).not.toMatch(/error/iu);
    expect(result.status).toBe(0);
    setupOutput = result.stdout;
  });

  afterAll(() => {
    sandbox.dispose();
  });

  it.each(['claude-code', 'codex', 'cursor', 'grok', 'goose', 'antigravity', 'copilot-cli'])(
    'reports the %s adapter as installed',
    (harness) => {
      expect(setupOutput).toMatch(new RegExp(`^\\s+${harness}\\s+installed\\b`, 'mu'));
    },
  );

  it('links the Claude relay plugin from the installed package, not a checkout', () => {
    const root = claudePluginRoot(sandbox.home);
    expect(root.startsWith(sandbox.prefix)).toBe(true);
    expect(existsSync(join(root, 'scripts', 'watch-inbox.sh'))).toBe(true);
  });

  it('starts the Codex app-server daemon and installs the Grok plugin', () => {
    const calls = sandbox.shimCalls();
    expect(calls).toContain('codex app-server daemon start');
    expect(calls.some((call) => call.startsWith('grok plugin install '))).toBe(true);
  });

  it('reports a healthy workspace from doctor', async () => {
    const doctor = await sandbox.concord(['doctor']);
    expect(doctor.status).toBe(0);
  });

  it.each(DRIVEN)(
    'gives a %s session one identity in its hooks and its MCP server',
    async (harness) => {
      const session = new DRIVERS[harness](sandbox);
      try {
        await session.start();
        expect(session.agentId).toBe(session.expectedAgentId());
        expect((await session.toolNames()).sort()).toEqual([
          'finish_work',
          'inspect_work',
          'start_work',
          'transfer_work',
          'update_work',
        ]);
        expect(await session.mcpAgentId()).toBe(session.expectedAgentId());
      } finally {
        await session.close();
      }
    },
  );

  for (const harness of UNDRIVEN) it.todo(`drives a ${harness} session end to end`);
});
