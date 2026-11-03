import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  installOpencodeMcpConfig,
  opencodeConfigInstalled,
} from '../../src/install/opencode-config.js';
import { recordedInvocations, writeFakeOpencode } from '../helpers/fake-opencode.js';

function setup(): { executable: string; log: string; env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'concord-oc-config-'));
  const log = join(dir, 'calls.log');
  return {
    executable: writeFakeOpencode(dir),
    log,
    dir,
    env: { ...process.env, FAKE_OC_LOG: log },
  };
}

function servers(dir: string, list: { name: string; status: string }[]): string {
  const path = join(dir, 'mcp.json');
  writeFileSync(
    path,
    JSON.stringify({ data: list.map((s) => ({ name: s.name, status: { status: s.status } })) }),
  );
  return path;
}

describe('installOpencodeMcpConfig', () => {
  it('asks OpenCode to register the server globally, pinning only the harness kind', () => {
    const { executable, log, env } = setup();

    installOpencodeMcpConfig(executable, env);

    expect(recordedInvocations(log)).toEqual([
      [
        'mcp',
        'add',
        '--global',
        '--env',
        'CONCORD_AGENT_KIND=opencode',
        'concord',
        '--',
        'concord-mcp',
      ],
    ]);
  });

  it('throws with OpenCode’s message when registration fails', () => {
    const { executable, env } = setup();

    expect(() => {
      installOpencodeMcpConfig(executable, { ...env, FAKE_OC_FAIL: '1' });
    }).toThrow('opencode mcp add failed: boom');
  });
});

describe('opencodeConfigInstalled', () => {
  it('is true when OpenCode lists Concord as connected', () => {
    const { executable, env, dir } = setup();
    const mcp = servers(dir, [{ name: 'concord', status: 'connected' }]);

    expect(opencodeConfigInstalled(executable, { ...env, FAKE_OC_MCP: mcp })).toBe(true);
  });

  it('is true while the server is still starting or has failed', () => {
    const { executable, env, dir } = setup();

    for (const status of ['pending', 'failed']) {
      const mcp = servers(dir, [{ name: 'concord', status }]);
      expect(opencodeConfigInstalled(executable, { ...env, FAKE_OC_MCP: mcp })).toBe(true);
    }
  });

  it('is false when Concord is disabled or only other servers exist', () => {
    const { executable, env, dir } = setup();

    const disabled = servers(dir, [{ name: 'concord', status: 'disabled' }]);
    expect(opencodeConfigInstalled(executable, { ...env, FAKE_OC_MCP: disabled })).toBe(false);

    const other = servers(dir, [{ name: 'other', status: 'connected' }]);
    expect(opencodeConfigInstalled(executable, { ...env, FAKE_OC_MCP: other })).toBe(false);
  });

  it('is false when the API call fails or answers with something unexpected', () => {
    const { executable, env, dir } = setup();

    expect(opencodeConfigInstalled(executable, { ...env, FAKE_OC_FAIL: '1' })).toBe(false);

    const junk = join(dir, 'junk.json');
    writeFileSync(junk, 'not json');
    expect(opencodeConfigInstalled(executable, { ...env, FAKE_OC_MCP: junk })).toBe(false);
  });
});
