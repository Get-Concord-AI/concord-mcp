import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveAutoAdaptersChoice, runSetup } from '../../src/cli/commands/setup.js';
import { readUserConfig, writeUserConfig } from '../../src/config/user-config.js';

const home = (): NodeJS.ProcessEnv => ({
  HOME: mkdtempSync(join(tmpdir(), 'concord-auto-adapters-')),
  PATH: '',
});

describe('resolveAutoAdaptersChoice', () => {
  const ask = (): Promise<boolean> => Promise.resolve(true);

  it('asks once, interactively, and then keeps the saved answer', async () => {
    const env = home();
    expect(await resolveAutoAdaptersChoice({ env, interactive: false, ask })).toBeUndefined();
    expect(await resolveAutoAdaptersChoice({ env, interactive: true, ask })).toBe(true);

    writeUserConfig(env, { autoAdapters: false });
    expect(await resolveAutoAdaptersChoice({ env, interactive: true, ask })).toBeUndefined();
    expect(await resolveAutoAdaptersChoice({ env, interactive: false, flag: true })).toBe(true);
  });

  it('is saved by setup in the user config', () => {
    const env = home();
    const repo = mkdtempSync(join(tmpdir(), 'concord-auto-adapters-repo-'));
    mkdirSync(join(repo, '.git'));
    runSetup(repo, { env: { ...env, CONCORD_REPO_ROOT: repo }, mcp: false, autoAdapters: true });
    expect(readUserConfig(env).autoAdapters).toBe(true);
  });
});
