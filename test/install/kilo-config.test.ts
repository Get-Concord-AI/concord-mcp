import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  kiloConfigHome,
  kiloGlobalConfigPaths,
  kiloMcpInstalled,
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

const CONCORD_ENTRY = {
  type: 'local',
  command: ['concord-mcp'],
  environment: { CONCORD_AGENT_KIND: 'kilo' },
};

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

describe('kiloGlobalConfigPaths', () => {
  it('lists the three filenames Kilo accepts, in docs order', () => {
    const { home, env } = kiloEnv();
    expect(kiloGlobalConfigPaths(env)).toEqual([
      join(home, '.config', 'kilo', 'kilo.json'),
      join(home, '.config', 'kilo', 'kilo.jsonc'),
      join(home, '.config', 'kilo', 'config.json'),
    ]);
  });
});

describe('kiloMcpInstalled', () => {
  it('is false when no config exists', () => {
    const { env } = kiloEnv();
    expect(kiloMcpInstalled(env)).toBe(false);
  });

  it('finds a Concord entry in kilo.jsonc', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.jsonc',
      `${JSON.stringify({ mcp: { concord: CONCORD_ENTRY, other: { type: 'remote', url: 'https://x' } } }, null, 2)}\n`,
    );
    expect(kiloMcpInstalled(env)).toBe(true);
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
    expect(kiloMcpInstalled(env)).toBe(true);
  });

  it('does not count a disabled Concord entry', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({ mcp: { concord: { ...CONCORD_ENTRY, enabled: false } } }),
    );
    expect(kiloMcpInstalled(env)).toBe(false);
  });

  it('does not count an entry somebody else wrote', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(
      home,
      'kilo.json',
      JSON.stringify({
        mcp: {
          concord: { type: 'local', command: ['my-own-server'], environment: { FOO: 'bar' } },
        },
      }),
    );
    expect(kiloMcpInstalled(env)).toBe(false);
  });

  it('does not count a Concord command carrying foreign environment', () => {
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
    expect(kiloMcpInstalled(env)).toBe(false);
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
    expect(kiloMcpInstalled(env)).toBe(true);
  });

  it('reports unreadable when a config file cannot be parsed', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.json', '{ not json');
    expect(kiloMcpInstalled(env)).toBe('unreadable');
  });
});

const serversSchema = z.object({
  mcp: z.record(z.string(), z.unknown()).optional(),
  agent: z.record(z.string(), z.unknown()).optional(),
  $schema: z.string().optional(),
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

  it('removes Concord from every global file that has it', () => {
    const { home, env } = kiloEnv();
    writeGlobalConfig(home, 'kilo.json', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));
    writeGlobalConfig(home, 'config.json', JSON.stringify({ mcp: { concord: CONCORD_ENTRY } }));

    uninstallKiloMcpConfig(env);

    for (const name of ['kilo.json', 'config.json']) {
      const config = serversSchema.parse(
        JSON.parse(readFileSync(join(home, '.config', 'kilo', name), 'utf8')),
      );
      expect(config.mcp?.['concord']).toBeUndefined();
    }
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
});
