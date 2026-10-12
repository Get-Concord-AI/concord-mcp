import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CONCORD_OPENCODE_SERVER_KEY,
  OpenCodeConfigParseError,
  installOpencodeMcpConfig,
  opencodeConfigFile,
  opencodeConfigInstalled,
  uninstallOpencodeConfig,
} from '../../src/install/opencode-config.js';
import { CONCORD_SERVER_COMMAND } from '../../src/install/mcp-config.js';

/** Parse a written config into a typed shape; no `any` escapes the parse. */
const opencodeConfigSchema = z
  .object({
    mcp: z.record(
      z.string(),
      z.object({
        type: z.string().optional(),
        command: z.array(z.string()).optional(),
        environment: z.record(z.string(), z.string()).optional(),
        enabled: z.boolean().optional(),
        url: z.string().optional(),
      }),
    ),
  })
  .loose();

const schemaWithSchema = z.object({ $schema: z.string() }).loose();
const telemetrySchema = z.object({ telemetry: z.boolean() }).loose();

/** Unrelated top-level keys a JSONC fixture may carry, narrowed concretely. */
const extrasSchema = z.object({ instructions: z.array(z.string()), model: z.string() }).loose();

function readOpencodeConfig(path: string): z.infer<typeof opencodeConfigSchema> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return opencodeConfigSchema.parse(raw);
}

describe('opencodeConfigFile', () => {
  it('prefers OPENCODE_CONFIG when set', () => {
    expect(opencodeConfigFile('/repo', { OPENCODE_CONFIG: '/custom/opencode.json' })).toBe(
      '/custom/opencode.json',
    );
  });

  it('falls back to opencode.jsonc when only that exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    writeFileSync(join(root, 'opencode.jsonc'), '{}\n');
    expect(opencodeConfigFile(root, {})).toBe(join(root, 'opencode.jsonc'));
  });

  it('uses opencode.json when it exists, even alongside jsonc', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    writeFileSync(join(root, 'opencode.json'), '{}\n');
    writeFileSync(join(root, 'opencode.jsonc'), '{}\n');
    expect(opencodeConfigFile(root, {})).toBe(join(root, 'opencode.json'));
  });

  it('defaults to opencode.json when neither exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    expect(opencodeConfigFile(root, {})).toBe(join(root, 'opencode.json'));
  });
});

describe('installOpencodeMcpConfig', () => {
  it('writes a local server entry with an array command, repo root, and kind', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    const path = installOpencodeMcpConfig(root, {});

    expect(path).toBe(join(root, 'opencode.json'));
    const server = readOpencodeConfig(path).mcp[CONCORD_OPENCODE_SERVER_KEY];
    expect(server?.type).toBe('local');
    expect(server?.command).toEqual([CONCORD_SERVER_COMMAND]);
    expect(server?.enabled).toBe(true);
    expect(server?.environment).toEqual({
      CONCORD_REPO_ROOT: root,
      CONCORD_AGENT_KIND: 'opencode',
    });
  });

  it('is idempotent: re-running produces identical output', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    const first = installOpencodeMcpConfig(root, {});
    const before = readFileSync(first, 'utf8');
    installOpencodeMcpConfig(root, {});
    expect(readFileSync(first, 'utf8')).toBe(before);
  });

  it('preserves other servers and unrelated top-level keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4-5',
      mcp: { other: { type: 'local', command: ['other-server'] } },
    };
    writeFileSync(join(root, 'opencode.json'), `${JSON.stringify(existing, null, 2)}\n`);

    const path = installOpencodeMcpConfig(root, {});
    const withSchema = schemaWithSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(withSchema.$schema).toBe('https://opencode.ai/config.json');
    const config = readOpencodeConfig(path);
    expect(config.mcp['other']).toEqual({ type: 'local', command: ['other-server'] });
    expect(config.mcp[CONCORD_OPENCODE_SERVER_KEY]?.command).toEqual([CONCORD_SERVER_COMMAND]);
    const raw = z
      .object({ model: z.string() })
      .loose()
      .parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(raw.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('preserves a previously pinned repo root when called without one', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    installOpencodeMcpConfig(root, {});
    // Simulate a re-run from a different checkout by rewriting the pinned root.
    const path = join(root, 'opencode.json');
    const existing = readOpencodeConfig(path);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          ...existing,
          mcp: {
            ...existing.mcp,
            [CONCORD_OPENCODE_SERVER_KEY]: {
              ...existing.mcp[CONCORD_OPENCODE_SERVER_KEY],
              environment: { CONCORD_REPO_ROOT: '/original', CONCORD_AGENT_KIND: 'opencode' },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    installOpencodeMcpConfig('/somewhere-else', { OPENCODE_CONFIG: path });
    const server = readOpencodeConfig(path).mcp[CONCORD_OPENCODE_SERVER_KEY];
    expect(server?.environment?.['CONCORD_REPO_ROOT']).toBe('/original');
  });

  it('preserves unrelated environment values the user added', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    installOpencodeMcpConfig(root, {});
    const path = join(root, 'opencode.json');
    const existing = readOpencodeConfig(path);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          ...existing,
          mcp: {
            ...existing.mcp,
            [CONCORD_OPENCODE_SERVER_KEY]: {
              ...existing.mcp[CONCORD_OPENCODE_SERVER_KEY],
              environment: {
                ...existing.mcp[CONCORD_OPENCODE_SERVER_KEY]?.environment,
                MY_CUSTOM: 'kept',
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    installOpencodeMcpConfig(root, {});

    const server = readOpencodeConfig(path).mcp[CONCORD_OPENCODE_SERVER_KEY];
    expect(server?.environment?.['MY_CUSTOM']).toBe('kept');
    expect(server?.environment?.['CONCORD_REPO_ROOT']).toBe(root);
    expect(server?.environment?.['CONCORD_AGENT_KIND']).toBe('opencode');
  });

  it('honors OPENCODE_CONFIG for the target path', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    const custom = join(root, 'sub', 'custom.json');
    const path = installOpencodeMcpConfig('/repo', { OPENCODE_CONFIG: custom });
    expect(path).toBe(custom);
    expect(
      readOpencodeConfig(path).mcp[CONCORD_OPENCODE_SERVER_KEY]?.environment?.['CONCORD_REPO_ROOT'],
    ).toBe('/repo');
  });

  it('leaves malformed config untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    writeFileSync(join(root, 'opencode.json'), '{ broken\n');
    expect(() => installOpencodeMcpConfig(root, {})).toThrow(OpenCodeConfigParseError);
    expect(readFileSync(join(root, 'opencode.json'), 'utf8')).toBe('{ broken\n');
  });

  it('parses JSONC comments and trailing commas without rewriting quoted values', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    writeFileSync(
      join(root, 'opencode.jsonc'),
      `{
  // project model
  "model": "anthropic/claude-sonnet-4-5",
  "instructions": ["Keep ,} unchanged"],
  "mcp": {
    "other": { "type": "local", "command": ["other"], },
  },
}
`,
    );

    const path = installOpencodeMcpConfig(root, {});
    expect(path).toBe(join(root, 'opencode.jsonc'));
    const config = readOpencodeConfig(path);
    // The quoted value keeps its comma and closer; only real trailing commas go.
    const extras = extrasSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(extras.instructions[0]).toBe('Keep ,} unchanged');
    expect(extras.model).toBe('anthropic/claude-sonnet-4-5');
    expect(config.mcp['other']).toEqual({ type: 'local', command: ['other'] });
    expect(config.mcp[CONCORD_OPENCODE_SERVER_KEY]?.command).toEqual([CONCORD_SERVER_COMMAND]);
  });

  it('writes the config with owner-only permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    const path = installOpencodeMcpConfig(root, {});
    chmodSync(path, 0o644);
    installOpencodeMcpConfig(root, {});
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});

describe('opencodeConfigInstalled', () => {
  it('is false when no config exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    expect(opencodeConfigInstalled(root, {})).toBe(false);
  });

  it('is true once registered and false after uninstall', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    expect(opencodeConfigInstalled(root, {})).toBe(false);
    installOpencodeMcpConfig(root, {});
    expect(opencodeConfigInstalled(root, {})).toBe(true);
    uninstallOpencodeConfig(root, {});
    expect(opencodeConfigInstalled(root, {})).toBe(false);
  });

  it('is false when the entry is explicitly disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    installOpencodeMcpConfig(root, {});
    const path = join(root, 'opencode.json');
    const config = readOpencodeConfig(path);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          ...config,
          mcp: {
            ...config.mcp,
            [CONCORD_OPENCODE_SERVER_KEY]: {
              ...config.mcp[CONCORD_OPENCODE_SERVER_KEY],
              enabled: false,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(opencodeConfigInstalled(root, {})).toBe(false);
  });
});

describe('uninstallOpencodeConfig', () => {
  it('removes only the Concord server and preserves everything else', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    installOpencodeMcpConfig(root, {});
    const path = join(root, 'opencode.json');
    const existing = readOpencodeConfig(path);
    const withOther = {
      ...existing,
      telemetry: false,
      mcp: { ...existing.mcp, other: { type: 'remote', url: 'https://example.test/mcp' } },
    };
    writeFileSync(path, `${JSON.stringify(withOther, null, 2)}\n`);

    uninstallOpencodeConfig(root, {});

    const result = readOpencodeConfig(path);
    expect(result.mcp).not.toHaveProperty(CONCORD_OPENCODE_SERVER_KEY);
    expect(result.mcp['other']).toEqual({ type: 'remote', url: 'https://example.test/mcp' });
    const withTelemetry = telemetrySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(withTelemetry.telemetry).toBe(false);
  });

  it('is a no-op when the config does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-oc-'));
    expect(() => {
      uninstallOpencodeConfig(root, {});
    }).not.toThrow();
  });
});
