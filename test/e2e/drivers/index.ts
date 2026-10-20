import { harnessNames, type HarnessName } from '../../../src/domain/harness-config.js';
import type { Sandbox } from '../support/sandbox.js';
import { ClaudeCodeSession } from './claude-code.js';
import { CodexSession } from './codex.js';
import { CursorSession } from './cursor.js';
import type { HarnessSession } from './session.js';

export type SessionClass = new (sandbox: Sandbox) => HarnessSession;

/**
 * A driver for every harness the matrix covers. The rest are listed in
 * `UNDRIVEN` so the gap shows up in every test run rather than being forgotten.
 */
export const DRIVERS = {
  'claude-code': ClaudeCodeSession,
  codex: CodexSession,
  cursor: CursorSession,
} satisfies Partial<Record<HarnessName, SessionClass>>;

export type DrivenHarness = keyof typeof DRIVERS;

export const DRIVEN: readonly DrivenHarness[] = ['claude-code', 'codex', 'cursor'];

export const UNDRIVEN: readonly HarnessName[] = harnessNames.filter(
  (name) => !DRIVEN.some((driven) => driven === name),
);
