import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { upsertBlock } from './block.js';
import { CONCORD_INSTRUCTIONS, CURSOR_MDC_HEADER } from './instructions.js';

interface InstallTarget {
  /** Path relative to the repo root. */
  relPath: string;
  /** Seed content used only when the file does not yet exist. */
  header?: string;
}

const TARGETS: readonly InstallTarget[] = [
  { relPath: 'CLAUDE.md' },
  { relPath: 'AGENTS.md' },
  { relPath: join('.codex', 'concord.md') },
  { relPath: join('.cursor', 'rules', 'concord.mdc'), header: CURSOR_MDC_HEADER },
];

function writeTarget(repoRoot: string, target: InstallTarget): string {
  const fullPath = join(repoRoot, target.relPath);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : (target.header ?? '');
  const updated = upsertBlock(existing, CONCORD_INSTRUCTIONS);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, updated);
  return target.relPath;
}

/**
 * Write (or idempotently update) Concord's instructions into every supported
 * client config, preserving any existing content. Returns the relative paths
 * written.
 */
export function installConcord(repoRoot: string): string[] {
  return TARGETS.map((target) => writeTarget(repoRoot, target));
}
