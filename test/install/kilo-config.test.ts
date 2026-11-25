import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  kiloConfigDir,
  kiloConfigHome,
  kiloConfigPaths,
  kiloMcpState,
  uninstallKiloMcpConfig,
} from '../../src/install/kilo-config.js';

function kiloEnv(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), 'concord-kilo-home-'));
  return { home, env: { HOME: home, PATH: '' } };
}

function writeGlobalConfig(home: string, name: string, content: string): string {
  const dir = join(home, '.config', 'kilo');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function writeConfigDirConfig(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const CONCORD_ENTRY = {
  type: 'local',
  command: ['concord-mcp'],
  environment: { CONCORD_AGENT_KIND: 'kilo' },
};

const serversSchema = z.object({
  mcp: z.record(z.string(), z.unknown()).optional(),
  agent: z.record(z.string(), z.unknown()).optional(),
  $schema: z.string().optional(),
});

describe('kiloConfigHome', () => {
  it('uses ~/.config/kilo by default', () => {
    const { home, env } = kiloEnv();
    expect(kiloConfigHome(env)).toBe(join(home, '.config', 'kilo'));
  });

  it('honors XDG_CONFIG_HOME', () => {
    const { env } = kiloEnv();
    const xdg = mkdtempSync(join(tmpdir(), 'concord-kilo-xdg-'));
    expect(kiloConfigHome({ ...env, XDG_CONFIG_HOME: xdg })).toBe(join(xdg, 'kilo'));
  });
});

describe('kiloConfigDir', () => {
  it('is undefined without KILO_CONFIG_DIR', () => {
    const { env } = kiloEnv();
    expect(kiloConfigDir(env)).toBeUndefined();
  });

  it('expands a leading ~ against the user home', () => {
    const { home, env } = kiloEnv();
    expect(kiloConfigDir({ ...env, KILO_CONFIG_DIR: '~/kilo-work' })).toBe(join(home, 'kilo-work'));
  });
});

describe('kiloConfigPaths', () => {
  it('lists the global files in Kilo merge order, lowest to highest', () => {
    const { home, env } = kiloEnv();
    expect(kiloConfigPaths(env)).toEqual([
      join(home, '.config', 'kilo', 'config.json'),
      join(home, '.config', 'kilo', 'kilo.json'),
      join(home, '.config', 'kilo', 'kilo.jsonc'),
      join(home, '.config', 'kilo', 'opencode.json'),
      join(home, '.config', 'kilo', 'opencode.jsonc'),
    ]);
  });

  it('appends KILO_CONFIG_DIR files after the global ones', () => {
    const { home, env } = kiloEnv();
    const dir = join(home, 'kilo-work');
    expect(kiloConfigPaths({ ...env, KILO_CONFIG_DIR: dir })).toEqual([
      ...kiloConfigPaths(env),
      join(dir, 'kilo.jsonc'),
      join(dir, 'kilo.json'),
      join(dir, 'opencode.jsonc'),
      join(dir, 'opencode.json'),
    ]);
  });
});

describe('kiloMcpState', () => {
  it('is none when no config exists', () => {
    const { env } = kiloEnv();
    expect(kiloMcpState(env)).toEqual({ state: 'none' });
  });

  it('finds a Concord entry in kilo.jsonc', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.jsonc',
      `${JSON.stringify({ mcp: { concord: CONCORD_ENTRY, other: { type: 'remote', url: 'https://x' } } }, null, 2)}\n`,
    );
    expect(kiloMcpState(env)).toEqual({ state: 'installed' });
  });

  it('reads JSONC comments and trailing commas', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.jsonc',
      `{
        // user comment
        "mcp": {
          "concord": { "type": "local", "command": ["concord-mcp"], },
        },
      }
      /* trailing comment */
      `,
    );
    expect(kiloMcpState(env)).toEqual({ state: 'installed' });
  });

  it('reports disabled when the winning entry has enabled: false', () => {
    const { home, env } = kiloEnv();
    const path = writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({ mcp: { concord: { ...CONCORD_ENTRY, enabled: false } } }),
    );
    expect(kiloMcpState(env)).toEqual({ state: 'disabled', path });
  });

  it('lets a later file disable an earlier enabled entry', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.jsonc', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));
    const later = writeGlobalConfig(
      home,
      'opencode.jsonc',
      JSON.stringify({ mcp: { concord: { enabled: false } } }),
    );
    // Kilo deep-merges: the later file only flips `enabled`.
    expect(kiloMcpState(env)).toEqual({ state: 'disabled', path: later });
  });

  it('lets a later file re-enable an earlier disabled entry', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.jsonc',
      JSON.stringify({ mcp: { concord: { ...CONCORD_ENTRY, enabled: false } } }),
    );
    writeGlobalConfig(
      home,
      'opencode.json',
      JSON.stringify({ mcp: { concord: { enabled: true } } }),
    );
    expect(kiloMcpState(env)).toEqual({ state: 'installed' });
  });

  it('prefers KILO_CONFIG_DIR entries over the global directory', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.jsonc', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));
    const dir = join(home, 'kilo-work');
    writeConfigDirConfig(
      dir,
      'kilo.jsonc',
      JSON.stringify({ mcp: { concord: { enabled: false } } }),
    );
    expect(kiloMcpState({ ...env, KILO_CONFIG_DIR: dir }).state).toBe('disabled');
  });

  it('reports conflict when the winning entry is not Concord-written', () => {
    const { home, env } = kiloEnv();
    const path = writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: {
          concord: { type: 'local', command: ['my-own-server'], environment: { FOO: 'bar' } },
        },
      }),
    );
    expect(kiloMcpState(env)).toEqual({ state: 'conflict', path });
  });

  it('reports conflict when Concord env carries a foreign key', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: {
          concord: {
            type: 'local',
            command: ['concord-mcp'],
            environment: { CONCORD_AGENT_KIND: 'kilo', CUSTOM: 'value' },
          },
        },
      }),
    );
    expect(kiloMcpState(env).state).toBe('conflict');
  });

  it('reports conflict for a concord-mcp argument inside a user wrapper', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: { concord: { type: 'local', command: ['node', 'proxy.js', 'concord-mcp'] } },
      }),
    );
    expect(kiloMcpState(env).state).toBe('conflict');
  });

  it('still owns an entry that uses the env alias with only Concord keys', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: {
          concord: { type: 'local', command: ['concord-mcp'], env: { CONCORD_AGENT_KIND: 'kilo' } },
        },
      }),
    );
    expect(kiloMcpState(env)).toEqual({ state: 'installed' });
  });

  it('reports conflict when the env alias carries a foreign key', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: {
          concord: { type: 'local', command: ['concord-mcp'], env: { MY_TOKEN: 'x' } },
        },
      }),
    );
    expect(kiloMcpState(env).state).toBe('conflict');
  });

  it('accepts the published package spec as the command', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: {
          concord: { type: 'local', command: ['npx', '-y', '@concord-ai/concord-mcp@1.2.3'] },
        },
      }),
    );
    expect(kiloMcpState(env)).toEqual({ state: 'installed' });
  });

  it('ignores a malformed sibling server instead of failing the file', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: {
          concord: CONCORD_ENTRY,
          broken: { command: 'not-an-array', environment: { PORT: 8080 } },
        },
      }),
    );
    expect(kiloMcpState(env)).toEqual({ state: 'installed' });
  });

  it('reports unreadable when a config file cannot be parsed', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.json', '{ not json');
    expect(kiloMcpState(env)).toEqual({ state: 'unreadable' });
  });

  it('reports unreadable even when another file has a working entry', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.json', '{ not json');
    writeGlobalConfig(home, 'kilo.jsonc', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));
    expect(kiloMcpState(env)).toEqual({ state: 'unreadable' });
  });
});

describe('uninstallKiloMcpConfig', () => {
  it('removes only the Concord entry and keeps other servers and keys', () => {
    const { home, env } = kiloEnv();
    const path = writeGlobalConfig(
      home,
      'kilo.jsonc',
      `${JSON.stringify(
        {
          $schema: 'https://app.kilo.ai/config.json',
          mcp: {
            concord: CONCORD_ENTRY,
            probe: { type: 'local', command: ['node', 'probe.mjs'] },
          },
          agent: { code: { model: 'vercel/x' } },
        },
        null,
        2,
      )}\n`,
    );

    uninstallKiloMcpConfig(env);

    const next = serversSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(next.mcp?.['concord']).toBeUndefined();
    expect(next.mcp?.['probe']).toBeDefined();
    expect(next.agent).toEqual({ code: { model: 'vercel/x' } });
    expect(next.$schema).toBe('https://app.kilo.ai/config.json');
  });

  it('preserves comments and formatting while removing the entry', () => {
    const { home, env } = kiloEnv();
    const path = writeGlobalConfig(
      home,
      'kilo.jsonc',
      `{
  // servers the user relies on
  "mcp": {
    "concord": { "type": "local", "command": ["concord-mcp"] },
    // keep this probe around
    "probe": { "type": "local", "command": ["node", "probe.mjs"] },
  },
  "agent": { "code": { "model": "vercel/x" } },
}
`,
    );

    uninstallKiloMcpConfig(env);

    const next = readFileSync(path, 'utf8');
    expect(next).toContain('// servers the user relies on');
    expect(next).toContain('// keep this probe around');
    expect(next).toContain('"probe"');
    expect(next).not.toContain('"concord"');
    expect(next).toContain('"agent"');
  });

  it('removes Concord from every config file that has it', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.json', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));
    writeGlobalConfig(home, 'config.json', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));
    const dir = join(home, 'kilo-work');
    writeConfigDirConfig(dir, 'opencode.json', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));

    uninstallKiloMcpConfig({ ...env, KILO_CONFIG_DIR: dir });

    for (const file of [
      join(home, '.config', 'kilo', 'kilo.json'),
      join(home, '.config', 'kilo', 'config.json'),
      join(dir, 'opencode.json'),
    ]) {
      const config = serversSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      expect(config.mcp?.['concord']).toBeUndefined();
    }
  });

  it('removes an owned entry that carries a trailing comma', () => {
    const { home, env } = kiloEnv();
    const path = writeGlobalConfig(
      home,
      'kilo.jsonc',
      `{
  "mcp": {
    "concord": { "type": "local", "command": ["concord-mcp"], },
    "keep": { "command": ["x"] }
  }
}
`,
    );

    uninstallKiloMcpConfig(env);

    const next = readFileSync(path, 'utf8');
    expect(next).not.toContain('"concord"');
    expect(next).toContain('"keep"');
  });

  it('leaves a concord entry somebody else wrote untouched', () => {
    const { home, env } = kiloEnv();
    const path = writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({ mcp: { concord: { type: 'local', command: ['mine'] } } }),
    );
    const before = readFileSync(path, 'utf8');

    uninstallKiloMcpConfig(env);

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('skips a malformed file but still removes entries from the others', () => {
    const { home, env } = kiloEnv();
    const broken = writeGlobalConfig(home, 'kilo.json', '{ not json');
    const good = writeGlobalConfig(
      home,
      'kilo.jsonc',
      `${JSON.stringify({ mcp: { concord: CONCORD_ENTRY, keep: { command: ['x'] } } }, null, 2)}\n// tail comment`,
    );

    uninstallKiloMcpConfig(env);

    expect(readFileSync(broken, 'utf8')).toBe('{ not json');
    const next = readFileSync(good, 'utf8');
    expect(next).not.toContain('"concord"');
    expect(next).toContain('"keep"');
    expect(next).toContain('// tail comment');
  });
});

describe('round-3 review regressions', () => {
  it('uninstall removes the root mcp.concord, not a nested provider one', () => {
    const { home, env } = kiloEnv();
    const path = writeGlobalConfig(
      home,
      'kilo.jsonc',
      `{
  "provider": {
    "custom": {
      "options": {
        "mcp": {
          "concord": { "type": "local", "command": ["concord-mcp"] }
        }
      }
    }
  },
  "mcp": {
    "concord": { "type": "local", "command": ["concord-mcp"] },
    "keep": { "command": ["x"] }
  }
}
`,
    );

    expect(kiloMcpState(env)).toEqual({ state: 'installed' });
    uninstallKiloMcpConfig(env);

    const next = readFileSync(path, 'utf8');
    // The nested provider entry survives untouched …
    expect(next).toContain('"provider"');
    const nestedSchema = z.object({
      provider: z.object({
        custom: z.object({
          options: z.object({ mcp: z.record(z.string(), z.unknown()) }),
        }),
      }),
      mcp: z.record(z.string(), z.unknown()).optional(),
    });
    const parsed = nestedSchema.parse(JSON.parse(next));
    expect(parsed.provider.custom.options.mcp['concord']).toBeDefined();
    // … and the root registration is the one removed.
    expect(parsed.mcp?.['concord']).toBeUndefined();
    expect(parsed.mcp?.['keep']).toBeDefined();
  });

  it('does not own a package spec carried inside a user wrapper', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: {
          concord: { type: 'local', command: ['node', 'proxy.js', '@concord-ai/concord-mcp'] },
        },
      }),
    );
    expect(kiloMcpState(env).state).toBe('conflict');
  });

  it('does not own an npx invocation whose arguments go beyond the runner shape', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: {
          concord: {
            type: 'local',
            command: ['npx', '-y', '@concord-ai/concord-mcp', '--user-flag'],
          },
        },
      }),
    );
    expect(kiloMcpState(env).state).toBe('conflict');
  });

  it('appends the KILO_CONFIG override file after every other source', () => {
    const { home, env } = kiloEnv();
    const override = join(home, 'custom-kilo.json');
    const paths = kiloConfigPaths({ ...env, KILO_CONFIG: override });
    expect(paths.at(-1)).toBe(override);
  });

  it('lets KILO_CONFIG disable an entry every other file enables', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.jsonc', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));
    const override = writeConfigDirConfig(
      join(home, 'elsewhere'),
      'override.json',
      JSON.stringify({ mcp: { concord: { enabled: false } } }),
    );

    const state = kiloMcpState({ ...env, KILO_CONFIG: override });
    expect(state.state).toBe('disabled');
    expect(state.path).toBe(override);
  });

  it('reports none for a bare enabled:false stub with no command or url', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.jsonc', JSON.stringify({ mcp: { concord: { enabled: false } } }));
    expect(kiloMcpState(env).state).toBe('none');
  });

  it('reports none after uninstall leaves a vestigial disable stub behind', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.json', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));
    writeGlobalConfig(home, 'kilo.jsonc', JSON.stringify({ mcp: { concord: { enabled: false } } }));

    expect(kiloMcpState(env).state).toBe('disabled');
    uninstallKiloMcpConfig(env);
    expect(kiloMcpState(env).state).toBe('none');
  });

  it('still reports conflict when a foreign server hides under the toggle', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({ mcp: { concord: { type: 'local', command: ['mine'] } } }),
    );
    writeGlobalConfig(home, 'kilo.jsonc', JSON.stringify({ mcp: { concord: { enabled: false } } }));
    expect(kiloMcpState(env).state).toBe('conflict');
  });
});
