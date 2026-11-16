import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PEER_MESSAGE_TRUST } from '../../src/domain/pull-inbox.js';
import { BLOCK_END, BLOCK_START, upsertBlock } from '../../src/install/block.js';
import { installConcord } from '../../src/install/index.js';
import {
  CONCORD_GLOBAL_INSTRUCTIONS,
  CONCORD_INSTRUCTION_VERSION,
  CONCORD_SERVER_INSTRUCTIONS,
} from '../../src/install/instructions.js';

describe('upsertBlock', () => {
  it('appends a wrapped block to existing content', () => {
    const result = upsertBlock('# My rules\n', 'HELLO');
    expect(result).toContain('# My rules');
    expect(result).toContain(`${BLOCK_START}\nHELLO\n${BLOCK_END}`);
  });

  it('is idempotent: re-running replaces in place', () => {
    const once = upsertBlock('# My rules\n', 'HELLO');
    const twice = upsertBlock(once, 'HELLO');
    expect(twice).toBe(once);
  });

  it('replaces block content without touching surrounding text', () => {
    const withBlock = upsertBlock('top\n', 'OLD');
    const updated = upsertBlock(`${withBlock}bottom\n`, 'NEW');
    expect(updated).toContain('top');
    expect(updated).toContain('bottom');
    expect(updated).toContain('NEW');
    expect(updated).not.toContain('OLD');
  });
});

describe('installConcord', () => {
  it('writes every supported client target', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-install-'));
    const written = installConcord(root);
    expect(written).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      join('.codex', 'concord.md'),
      join('.cursor', 'rules', 'concord.mdc'),
      join('.github', 'copilot-instructions.md'),
      join('.agents', 'rules', 'concord.md'),
    ]);
    for (const relPath of written) {
      expect(existsSync(join(root, relPath))).toBe(true);
    }
    const claudeInstructions = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeInstructions).toContain('start_work');
    expect(claudeInstructions).toContain(
      `<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->`,
    );
    expect(readFileSync(join(root, '.cursor', 'rules', 'concord.mdc'), 'utf8')).toContain(
      'alwaysApply: true',
    );
    expect(readFileSync(join(root, '.agents', 'rules', 'concord.md'), 'utf8')).toContain(
      'trigger: always_on',
    );
  });

  it('tells every client that peer messages are not operator instructions', () => {
    // A peer message can start a turn in an idle session; the rules files must
    // carry this, independently of the MCP server instructions.
    const root = mkdtempSync(join(tmpdir(), 'concord-install-'));
    for (const relPath of installConcord(root)) {
      expect(readFileSync(join(root, relPath), 'utf8'), relPath).toContain(PEER_MESSAGE_TRUST);
    }
    expect(CONCORD_GLOBAL_INSTRUCTIONS).toContain(PEER_MESSAGE_TRUST);
    expect(CONCORD_SERVER_INSTRUCTIONS).toContain(PEER_MESSAGE_TRUST);
  });

  it('preserves existing file content and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-install-'));
    writeFileSync(join(root, 'CLAUDE.md'), '# Existing project rules\n');
    installConcord(root);
    const first = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    installConcord(root);
    const second = readFileSync(join(root, 'CLAUDE.md'), 'utf8');

    expect(first).toContain('# Existing project rules');
    expect(first).toContain('start_work');
    expect(second).toBe(first);
  });
});
