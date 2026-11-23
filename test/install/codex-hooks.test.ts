import { describe, expect, it } from 'vitest';

import { upsertCodexHooks, upsertCodexMcpServer } from '../../src/install/codex-config.js';

const BEGIN = '# >>> concord hooks >>>';
const END = '# <<< concord hooks <<<';
const BLOCK = upsertCodexHooks(undefined).trimEnd();
/** A begin marker and its two comment lines, as drift leaves them behind. */
const STRAY_BEGIN = BLOCK.split('\n').slice(0, 3).join('\n');

function nonBlank(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

function expectOneBlock(text: string): void {
  const lines = text.split('\n');
  expect(lines.filter((line) => line === BEGIN)).toHaveLength(1);
  expect(lines.filter((line) => line === END)).toHaveLength(1);
  expect(lines.indexOf(BEGIN)).toBeLessThan(lines.indexOf(END));
  expect(text.match(/\[\[hooks\.SessionStart\]\]/gu)).toHaveLength(1);
}

/** The non-blank lines before and after Concord's block, in order. */
function outsideBlock(text: string): string[] {
  const lines = text.split('\n');
  const outside = [...lines.slice(0, lines.indexOf(BEGIN)), ...lines.slice(lines.indexOf(END) + 1)];
  return outside.filter((line) => line.trim() !== '');
}

describe('upsertCodexHooks', () => {
  it('creates the config when Codex has none', () => {
    const result = upsertCodexHooks(undefined);

    expect(result).toContain('[[hooks.SessionStart]]');
    expect(result).toContain('[[hooks.PostToolUse]]');
    expect(result).toContain('[[hooks.Stop]]');
  });

  it('is a no-op when applied twice', () => {
    const once = upsertCodexHooks('model = "gpt-5.6"\n');

    expect(upsertCodexHooks(once)).toBe(once);
  });

  it('keeps the user config it was added to', () => {
    const result = upsertCodexHooks('model = "gpt-5.6"\nnotify = ["thing"]\n');

    expect(result).toContain('model = "gpt-5.6"');
    expect(result).toContain('notify = ["thing"]');
  });

  it('appends after existing tables, so their keys are not re-parented', () => {
    const result = upsertCodexHooks('[mcp_servers.concord]\ncommand = "concord-mcp"\n');

    expect(result.indexOf('[mcp_servers.concord]')).toBeLessThan(result.indexOf('[[hooks.'));
    expect(result).toContain('command = "concord-mcp"');
  });

  it('replaces a previous block rather than stacking a second one', () => {
    const stale = upsertCodexHooks(undefined).replace(
      'concord inbox register --from-hook --provider codex',
      'concord inbox register --old-flag',
    );
    const result = upsertCodexHooks(stale);

    expect(result).not.toContain('--old-flag');
    expect(result.match(/\[\[hooks\.SessionStart\]\]/gu)).toHaveLength(1);
  });

  it('migrates exact legacy unfenced hooks without duplicating relay hosts', () => {
    const legacy = `model = "gpt-5.6"

[[hooks.SessionStart]]

[[hooks.SessionStart.hooks]]
type = "command"
command = "concord inbox register --from-hook --provider codex"

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "concord inbox drain --from-hook --provider codex --format post-tool-use"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "concord inbox drain --from-hook --provider codex --format stop"

[desktop]
followUpQueueMode = "queue"
`;

    const result = upsertCodexHooks(upsertCodexHooks(legacy));

    expect(result.match(/\[\[hooks\.SessionStart\]\]/gu)).toHaveLength(1);
    expect(result.match(/\[\[hooks\.PostToolUse\]\]/gu)).toHaveLength(1);
    expect(result.match(/\[\[hooks\.Stop\]\]/gu)).toHaveLength(1);
    expect(result).toContain('[desktop]\nfollowUpQueueMode = "queue"');
    expect(result).toContain('model = "gpt-5.6"');
  });

  it('preserves a user hook with a different command during legacy migration', () => {
    const custom = `[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "my-session-hook"
`;

    const result = upsertCodexHooks(custom);

    expect(result).toContain('command = "my-session-hook"');
    expect(result.match(/\[\[hooks\.SessionStart\]\]/gu)).toHaveLength(2);
  });

  it('keeps hook trust that Codex appended inside the block', () => {
    // Codex writes trust into config.toml at EOF, which lands inside our fence
    // because the end marker is the last line. Losing it silently re-prompts.
    const trusted = upsertCodexHooks(undefined).replace(
      '# <<< concord hooks <<<',
      '[hooks.state."/Users/me/.codex/config.toml:session_start:0:0"]\n' +
        'trusted_hash = "sha256:abc123"\n' +
        '# <<< concord hooks <<<',
    );

    const result = upsertCodexHooks(trusted);

    expect(result).toContain('trusted_hash = "sha256:abc123"');
    expect(result).toContain('[[hooks.SessionStart]]');
  });

  it('moves preserved trust outside the fence so later rewrites cannot reach it', () => {
    const trusted = upsertCodexHooks(undefined).replace(
      '# <<< concord hooks <<<',
      '[hooks.state."x:stop:0:0"]\ntrusted_hash = "sha256:def456"\n# <<< concord hooks <<<',
    );
    const once = upsertCodexHooks(trusted);

    expect(once.indexOf('# <<< concord hooks <<<')).toBeLessThan(once.indexOf('trusted_hash'));
    // And it survives every subsequent run unchanged.
    expect(upsertCodexHooks(once)).toBe(once);
  });

  it('composes with the MCP server table without either clobbering the other', () => {
    const result = upsertCodexMcpServer(upsertCodexHooks('model = "gpt-5.6"\n'));

    expect(result).toContain('[mcp_servers.concord]');
    expect(result).toContain('[[hooks.PostToolUse]]');
    expect(result).toContain('model = "gpt-5.6"');
  });

  it('recovers when an end marker sits above the block', () => {
    // The layout of a real drifted config.
    const server = '[mcp_servers.concord]\ncommand = "concord-mcp"';
    const trust = [
      '[hooks.state]',
      '',
      '[hooks.state."/home/me/.codex/config.toml:post_tool_use:0:0"]',
      'trusted_hash = "sha256:aaa"',
      '',
      '[hooks.state."/home/me/.codex/config.toml:stop:0:0"]',
      'trusted_hash = "sha256:bbb"',
    ].join('\n');
    const settings = '[projects."/tmp/demo"]\ntrust_level = "trusted"\n\n[tui]\nalt_screen = true';
    const drifted = `${[server, `${trust}\n${END}`, settings, STRAY_BEGIN, BLOCK].join('\n\n')}\n`;

    const result = upsertCodexHooks(drifted);

    expectOneBlock(result);
    expect(outsideBlock(result)).toEqual(nonBlank(`${server}\n${trust}\n${settings}`));
    expect(upsertCodexHooks(result)).toBe(result);
  });

  it('never fences in Codex settings', () => {
    // The layout reported in #265: Codex's own tables between stray markers.
    const trust =
      '[hooks.state."/home/me/.codex/config.toml:stop:0:0"]\ntrusted_hash = "sha256:aaa"';
    const settings =
      '[desktop]\nfollowUpQueueMode = "queue"\n\n' +
      '[plugins."template-creator@openai-primary-runtime"]\nenabled = true';
    const drifted = `${[
      `${trust}\n${END}`,
      STRAY_BEGIN,
      `${STRAY_BEGIN}\n${settings}\n${END}`,
      BLOCK,
    ].join('\n\n')}\n`;

    const result = upsertCodexHooks(drifted);

    expectOneBlock(result);
    expect(result).toContain(settings);
    expect(outsideBlock(result)).toEqual(nonBlank(`${trust}\n${settings}`));
  });

  it('keeps one block across repeated setup runs', () => {
    // Setup rewrites the server table, then the hooks, after Codex has put its
    // trust inside the block: the chain that broke real configs.
    const trust = '[hooks.state."x:stop:0:0"]\ntrusted_hash = "sha256:abc"';
    let config = `[mcp_servers.concord]\ncommand = "concord-mcp"\n\n${BLOCK.replace(END, `${trust}\n${END}`)}\n`;

    for (let run = 0; run < 3; run += 1) {
      config = upsertCodexHooks(upsertCodexMcpServer(config));

      expectOneBlock(config);
      expect(config).toContain(trust);
    }
  });
});
