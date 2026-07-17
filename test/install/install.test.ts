import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BLOCK_END, BLOCK_START, upsertBlock } from '../../src/install/block.js';
import { installConcord } from '../../src/install/index.js';

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
  it('writes all four client targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-install-'));
    const written = installConcord(root);
    expect(written).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      join('.codex', 'concord.md'),
      join('.cursor', 'rules', 'concord.mdc'),
    ]);
    for (const relPath of written) {
      expect(existsSync(join(root, relPath))).toBe(true);
    }
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('claim_work');
    expect(readFileSync(join(root, '.cursor', 'rules', 'concord.mdc'), 'utf8')).toContain(
      'alwaysApply: true',
    );
  });

  it('preserves existing file content and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-install-'));
    writeFileSync(join(root, 'CLAUDE.md'), '# Existing project rules\n');
    installConcord(root);
    const first = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    installConcord(root);
    const second = readFileSync(join(root, 'CLAUDE.md'), 'utf8');

    expect(first).toContain('# Existing project rules');
    expect(first).toContain('claim_work');
    expect(second).toBe(first);
  });
});
