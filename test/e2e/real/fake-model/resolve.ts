import type { JsonObject } from '../../support/mcp.js';
import { isShell, type Intent } from './brain.js';

/** One assistant step in harness terms: a tool call or a final message. */
export type Step =
  { kind: 'tool'; name: string; input: JsonObject } | { kind: 'text'; text: string };

/**
 * Turn an intent into a call the harness can execute with the tools it offers:
 * Concord's tools directly (Claude Code `mcp__concord__*`, Codex
 * `mcp__concord/*`, Goose `concord-relay__*`) or through Grok's `use_tool`.
 */
export function resolve(intent: Intent, tools: readonly string[]): Step {
  switch (intent.kind) {
    case 'load-tools':
      return {
        kind: 'tool',
        name: 'ToolSearch',
        input: {
          query: 'select:mcp__concord__start_work,mcp__concord__update_work',
          max_results: 5,
        },
      };
    case 'concord': {
      const direct = tools.find(
        (tool) => tool.includes('concord') && tool.endsWith(intent.operation),
      );
      if (direct !== undefined) return { kind: 'tool', name: direct, input: intent.input };
      if (tools.includes('tool_call')) {
        return {
          kind: 'tool',
          name: 'tool_call',
          input: {
            calls: [{ name: `mcp__concord__${intent.operation}`, arguments: intent.input }],
          },
        };
      }
      return {
        kind: 'tool',
        name: 'use_tool',
        input: { tool_name: `concord__${intent.operation}`, tool_input: intent.input },
      };
    }
    case 'monitor':
      return {
        kind: 'tool',
        name: 'monitor',
        input: { command: intent.command, description: 'Concord inbox', persistent: true },
      };
    case 'shell': {
      const shell = tools.find(isShell);
      if (shell === undefined) return { kind: 'text', text: 'No shell tool is available.' };
      if (shell === 'exec_command')
        return { kind: 'tool', name: shell, input: { cmd: intent.command } };
      if (shell === 'Bash') {
        return {
          kind: 'tool',
          name: shell,
          input: { command: intent.command, description: 'wait' },
        };
      }
      return { kind: 'tool', name: shell, input: { command: intent.command } };
    }
    case 'tool':
      return { kind: 'tool', name: intent.name, input: intent.input };
    case 'text':
      return { kind: 'text', text: intent.text };
  }
}
