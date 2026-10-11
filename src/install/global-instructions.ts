import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { upsertBlock } from './block.js';
import { CURSOR_MDC_HEADER } from './instructions.js';

/** User-level preference: applies even before a repository has Concord files. */
export const GLOBAL_CONCORD_INSTRUCTIONS = `## Concord in coding repositories

Use Concord for shared work-state and coordination when working in a repository,
including newly created or cloned repositories.

- Before editing, find the repository root and check for Concord's generated
  instructions in AGENTS.md or CLAUDE.md. If they are missing, run
  \`concord setup --no-global-instructions\` from that root once, then read the
  generated instructions. An existing .concord/ directory alone does not mean
  the repository's client configuration is complete.
- Follow the repository's Concord workflow: start_work before editing,
  inspect_work/update_work while working, transfer_work for handoffs, and
  finish_work with evidence before finishing. Use the session identity provided
  by your harness; do not invent an agent id.
- If setup fails or Concord tools are unavailable, explain the blocker and use
  \`concord doctor\` to diagnose it; do not repeatedly rerun setup. A client restart
  may be needed to load a newly registered MCP server.
- Respect explicit user or repository instructions that opt out of Concord.
  Do not initialize unrelated directories or add Concord as an app dependency.
`;

function configuredPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Install personal defaults for all supported clients, including future installs. */
export function installGlobalInstructions(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = configuredPath(env['HOME']) ?? configuredPath(env['USERPROFILE']) ?? homedir();
  const codexHome = configuredPath(env['CODEX_HOME']) ?? join(home, '.codex');
  const override = join(codexHome, 'AGENTS.override.md');
  // Codex loads only the first non-empty global instruction file.
  const codexFile =
    existsSync(override) && readFileSync(override, 'utf8').trim() !== ''
      ? override
      : join(codexHome, 'AGENTS.md');
  const targets = [
    { path: codexFile, header: '' },
    {
      path: join(configuredPath(env['CLAUDE_CONFIG_DIR']) ?? join(home, '.claude'), 'CLAUDE.md'),
      header: '',
    },
    { path: join(home, '.cursor', 'rules', 'concord.mdc'), header: CURSOR_MDC_HEADER },
    { path: join(home, '.gemini', 'GEMINI.md'), header: '' },
    {
      path: join(configuredPath(env['GROK_HOME']) ?? join(home, '.grok'), 'AGENTS.md'),
      header: '',
    },
  ];

  return targets.map(({ path, header }) => {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : header;
    const updated = upsertBlock(existing, GLOBAL_CONCORD_INSTRUCTIONS);
    if (updated !== existing) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, updated);
    }
    return path;
  });
}
