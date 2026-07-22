import { readFileSync } from 'node:fs';

import type { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

import type { Repositories } from '../../db/index.js';
import { openContext } from '../context.js';
import { checkFileOverlaps } from './check.js';

/** The subset of Claude Code's PreToolUse payload we need: the edited file path.
 * Everything else is passed through and ignored. */
const preToolUsePayloadSchema = z
  .object({
    tool_input: z.object({ file_path: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export interface HookDecision {
  /** True → deny the tool call (exit 2). */
  block: boolean;
  /** Message for stderr (shown to the agent); empty when there is nothing to say. */
  message: string;
}

/**
 * Decide whether a Claude Code PreToolUse event (Edit/Write/MultiEdit) should be
 * blocked because the edited file is claimed by another active task.
 *
 * `selfTaskId` (from `$CONCORD_TASK`) excludes your own claim. Without it we
 * cannot tell your own files apart from a real conflict, so we advise but never
 * block — blocking an agent from editing its own claimed files would be worse
 * than the problem this guards against.
 */
export function decidePreToolUse(
  repos: Repositories,
  rawJson: string,
  selfTaskId?: string,
): HookDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { block: false, message: '' };
  }
  const payload = preToolUsePayloadSchema.parse(parsed);
  const filePath = payload.tool_input?.file_path;
  if (filePath === undefined || filePath === '') {
    return { block: false, message: '' };
  }

  const overlaps = checkFileOverlaps(repos, [filePath], selfTaskId);
  if (overlaps.length === 0) {
    return { block: false, message: '' };
  }

  const detail = overlaps.map((overlap) => `${overlap.taskId} (${overlap.title})`).join(', ');
  if (selfTaskId === undefined) {
    return {
      block: false,
      message: `Concord: ${filePath} is also claimed by ${detail}. Set CONCORD_TASK=<your task id> to block colliding edits.`,
    };
  }
  return {
    block: true,
    message: `Concord: ${filePath} is claimed by another active task (${detail}). Coordinate or update your claim before editing.`,
  };
}

/** Read piped stdin to a string. Returns '' when attached to a TTY (no input). */
function readStdin(): string {
  if (process.stdin.isTTY) {
    return '';
  }
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function registerHookCommand(program: Command): void {
  program
    .command('hook <event>')
    .description(
      'Run a Concord hook. event: pre-tool-use (reads a Claude Code PreToolUse JSON payload on stdin)',
    )
    .action((event) => {
      if (event !== 'pre-tool-use') {
        process.stderr.write(`Unknown hook event: ${event}\n`);
        process.exitCode = 1;
        return;
      }
      const decision = decidePreToolUse(
        openContext(process.cwd()).repos,
        readStdin(),
        process.env['CONCORD_TASK'],
      );
      if (decision.message !== '') {
        process.stderr.write(`${decision.message}\n`);
      }
      if (decision.block) {
        // Claude Code treats PreToolUse exit code 2 as "deny the tool call".
        process.exitCode = 2;
      }
    });
}
