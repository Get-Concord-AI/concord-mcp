import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  upsertJunieHooksConfig,
  removeJunieHooksConfig,
  junieHooksInstalled,
} from '../../src/install/junie-hooks.js';

const hookEntrySchema = z.object({
  matcher: z.string(),
  hooks: z.array(z.object({ type: z.string(), command: z.string() })),
});
const configSchema = z.object({
  hooks: z.record(z.string(), z.array(hookEntrySchema)).optional(),
});

function parseConfig(source: string) {
  return configSchema.parse(JSON.parse(source));
}

describe('junie-hooks', () => {
  it('adds all three hook events to an empty config', () => {
    const next = upsertJunieHooksConfig(undefined);
    const parsed = parseConfig(next);
    expect(parsed.hooks?.['SessionStart']).toBeDefined();
    expect(parsed.hooks?.['UserPromptSubmit']).toBeDefined();
    expect(parsed.hooks?.['SessionEnd']).toBeDefined();
    expect(parsed.hooks?.['SessionStart']?.[0]?.hooks[0]?.command).toBe(
      'concord hook junie-session-start',
    );
    expect(parsed.hooks?.['UserPromptSubmit']?.[0]?.hooks[0]?.command).toBe(
      'concord hook junie-user-prompt-submit',
    );
    expect(parsed.hooks?.['SessionEnd']?.[0]?.hooks[0]?.command).toBe(
      'concord hook junie-session-end',
    );
  });

  it('preserves existing hooks when adding Concord hooks', () => {
    const existing = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'custom',
            hooks: [{ type: 'command', command: 'echo hello' }],
          },
        ],
      },
    });
    const next = upsertJunieHooksConfig(existing);
    const parsed = parseConfig(next);
    expect(parsed.hooks?.['SessionStart']).toHaveLength(2);
    expect(parsed.hooks?.['SessionStart']?.[0]?.hooks[0]?.command).toBe('echo hello');
    expect(parsed.hooks?.['SessionStart']?.[1]?.hooks[0]?.command).toBe(
      'concord hook junie-session-start',
    );
  });

  it('is idempotent — calling twice returns the original source', () => {
    const first = upsertJunieHooksConfig(undefined);
    const second = upsertJunieHooksConfig(first);
    expect(second).toBe(first);
  });

  it('removes only Concord hooks, preserving user hooks', () => {
    const withHooks = upsertJunieHooksConfig(
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'custom',
              hooks: [{ type: 'command', command: 'echo hello' }],
            },
          ],
        },
      }),
    );
    const cleaned = removeJunieHooksConfig(withHooks);
    const parsed = parseConfig(cleaned);
    expect(parsed.hooks?.['SessionStart']).toHaveLength(1);
    expect(parsed.hooks?.['SessionStart']?.[0]?.hooks[0]?.command).toBe('echo hello');
    expect(parsed.hooks?.['UserPromptSubmit']).toBeUndefined();
    expect(parsed.hooks?.['SessionEnd']).toBeUndefined();
  });

  it('removes the entire hooks key when only Concord hooks remain', () => {
    const withHooks = upsertJunieHooksConfig(undefined);
    const cleaned = removeJunieHooksConfig(withHooks);
    const parsed = parseConfig(cleaned);
    expect(parsed.hooks).toBeUndefined();
  });

  it('detects installed hooks via junieHooksInstalled', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-junie-hooks-'));
    const configPath = join(home, '.junie', 'config.json');
    mkdirSync(join(home, '.junie'), { recursive: true });

    expect(junieHooksInstalled({ HOME: home })).toBe(false);

    const withHooks = upsertJunieHooksConfig(undefined);
    writeFileSync(configPath, withHooks);
    expect(junieHooksInstalled({ HOME: home })).toBe(true);

    const cleaned = removeJunieHooksConfig(withHooks);
    writeFileSync(configPath, cleaned);
    expect(junieHooksInstalled({ HOME: home })).toBe(false);
  });

  it('returns false when config.json is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-junie-no-config-'));
    expect(junieHooksInstalled({ HOME: home })).toBe(false);
  });

  it('returns false when config.json has no hooks key', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-junie-no-hooks-'));
    const configPath = join(home, '.junie', 'config.json');
    mkdirSync(join(home, '.junie'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ model: 'test' }));
    expect(junieHooksInstalled({ HOME: home })).toBe(false);
  });
});
