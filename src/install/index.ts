import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { upsertBlock } from './block.js';
import {
  ANTIGRAVITY_INSTRUCTIONS,
  ANTIGRAVITY_RULE_HEADER,
  CLINE_INSTRUCTIONS,
  CONCORD_INSTRUCTIONS,
  CURSOR_MDC_HEADER,
  KIRO_INSTRUCTIONS,
  KIRO_STEERING_HEADER,
} from './instructions.js';

interface InstallTarget {
  /** Path relative to the repo root. */
  relPath: string;
  /** Seed content used only when the file does not yet exist. */
  header?: string;
  /** Custom instructions content instead of generic CONCORD_INSTRUCTIONS. */
  instructions?: string;
}

const TARGETS: readonly InstallTarget[] = [
  { relPath: 'CLAUDE.md' },
  { relPath: 'AGENTS.md' },
  { relPath: join('.codex', 'concord.md') },
  { relPath: join('.cursor', 'rules', 'concord.mdc'), header: CURSOR_MDC_HEADER },
  { relPath: join('.github', 'copilot-instructions.md') },
  {
    relPath: join('.agents', 'rules', 'concord.md'),
    header: ANTIGRAVITY_RULE_HEADER,
    instructions: ANTIGRAVITY_INSTRUCTIONS,
  },
  {
    relPath: join('.kiro', 'steering', 'concord.md'),
    header: KIRO_STEERING_HEADER,
    instructions: KIRO_INSTRUCTIONS,
  },
  // Cline reads rules from both directories; the same managed block in each
  // keeps working whichever layout a given Cline version prefers. Older
  // Cline versions read a single `.clinerules` file instead — installConcord
  // retargets this entry into that file when it exists.
  { relPath: join('.clinerules', 'concord.md'), instructions: CLINE_INSTRUCTIONS },
  { relPath: join('.cline', 'rules', 'concord.md'), instructions: CLINE_INSTRUCTIONS },
];

const CLINE_RULES_DIR_TARGET = join('.clinerules', 'concord.md');

function writeTarget(repoRoot: string, target: InstallTarget): string {
  const fullPath = join(repoRoot, target.relPath);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : (target.header ?? '');
  const updated = upsertBlock(existing, target.instructions ?? CONCORD_INSTRUCTIONS);
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
  // A single-file `.clinerules` cannot also be the `.clinerules/` directory:
  // merge the managed block into the file itself rather than failing setup.
  const legacyRules = join(repoRoot, '.clinerules');
  const clineRulesIsFile = existsSync(legacyRules) && !statSync(legacyRules).isDirectory();
  return TARGETS.map((target) =>
    writeTarget(
      repoRoot,
      target.relPath === CLINE_RULES_DIR_TARGET && clineRulesIsFile
        ? { ...target, relPath: '.clinerules' }
        : target,
    ),
  );
}
