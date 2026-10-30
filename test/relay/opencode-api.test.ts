import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findOpenCodeExecutable } from '../../src/relay/opencode-api.js';

function desktopCli(appData: string, version: string): string {
  const directory = join(appData, 'ai.opencode.desktop', 'cli', version);
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, 'opencode-cli.exe');
  writeFileSync(executable, '');
  return executable;
}

describe('findOpenCodeExecutable', () => {
  it('prefers an explicit override', () => {
    expect(findOpenCodeExecutable({ CONCORD_OPENCODE_BIN: ' /opt/oc ' })).toBe('/opt/oc');
  });

  it('picks the newest bundled desktop CLI by version, not by name', () => {
    const appData = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    desktopCli(appData, '2.9.0-x64');
    const newest = desktopCli(appData, '2.10.1-x64');

    expect(findOpenCodeExecutable({ APPDATA: appData })).toBe(newest);
  });

  it('falls back to opencode on PATH when no desktop CLI exists', () => {
    const appData = mkdtempSync(join(tmpdir(), 'concord-oc-'));

    expect(findOpenCodeExecutable({ APPDATA: appData })).toBe('opencode');
    expect(findOpenCodeExecutable({})).toBe('opencode');
  });
});
