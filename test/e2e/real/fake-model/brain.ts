import type { JsonObject } from '../../support/mcp.js';

/**
 * The scripted agent behind the fake model API. Every harness sends the whole
 * conversation with each request; the brain reads it and picks the one next
 * step a cooperative model would take:
 *
 * 1. load Concord's tools if the harness defers them (Claude Code's ToolSearch);
 * 2. answer any `[concord from <agent> id=<id>]` message it has not replied to;
 * 3. `start_work` once;
 * 4. send a message when the prompt says `tell <agent>: <text>`;
 * 5. start the inbox monitor when a hook asks for one (Grok);
 * 6. ask the user a question (Claude Code's AskUserQuestion) when the prompt
 *    says `ask the user`, which blocks the turn until someone answers;
 * 7. run `sleep N` when the prompt says so, to stay busy mid-turn;
 * 8. otherwise end the turn.
 *
 * A message whose body starts with `SILENT-` is read but never answered, so a
 * test can see a read receipt that no reply could have caused.
 *
 * Dialect adapters translate requests into a `Conversation` and the chosen
 * `Intent` into a concrete tool call for that harness.
 */

export interface ToolCall {
  /** Qualified name: `ns/name` for namespaced tools, the inner name for `use_tool`. */
  name: string;
  input: JsonObject;
}

export interface Conversation {
  /** Tools on offer, with namespaced tools as `ns/name`. */
  tools: string[];
  /** Tool calls the assistant already made, oldest first. */
  calls: ToolCall[];
  /** Everything the model has been told: prompts, hook context, tool results. */
  text: string;
  /** Every user prompt, which carries the scenario's instructions. */
  prompt: string;
  /**
   * Whether this request starts a new turn: its last message is fresh input
   * (a prompt, a monitor event, an injected turn) rather than a tool result
   * continuing a turn already under way.
   */
  opensTurn: boolean;
}

export type Intent =
  | { kind: 'load-tools' }
  | { kind: 'concord'; operation: 'start_work' | 'update_work'; input: JsonObject }
  | { kind: 'monitor'; command: string }
  | { kind: 'shell'; command: string }
  | { kind: 'tool'; name: string; input: JsonObject }
  | { kind: 'text'; text: string };

/** Messages the brain reads but never answers. */
export const SILENT = 'SILENT-';
const ASK_USER = 'AskUserQuestion';
const FRAME = /\[concord from (\S+) id=([^\s\]]+)[^\]]*\]\s*([^\n<]*)/gu;
const AGENT_ID = /this session is agent `([^`]+)`/u;
const MONITOR_ASK = /persistent `monitor`[^`]*`(concord inbox watch [^`]+)`/gu;

function calledTool(conversation: Conversation, suffix: string): ToolCall[] {
  return conversation.calls.filter((call) => call.name.endsWith(suffix));
}

/** Whether the harness offers Concord's tools directly or through a meta-tool. */
export function concordReachable(tools: readonly string[]): boolean {
  return (
    tools.some((tool) => tool.includes('concord') && tool.endsWith('update_work')) ||
    tools.includes('use_tool')
  );
}

export function decide(conversation: Conversation): Intent {
  // A harness whose MCP server cannot see the session tells the model its id.
  const agentId = AGENT_ID.exec(conversation.text)?.[1];
  const withId = (input: JsonObject): JsonObject =>
    agentId === undefined ? input : { ...input, agent_id: agentId };
  const reachable = concordReachable(conversation.tools);

  if (!reachable && conversation.tools.includes('ToolSearch')) {
    if (calledTool(conversation, 'ToolSearch').length === 0) return { kind: 'load-tools' };
  }

  const replied = new Set(
    calledTool(conversation, 'update_work').map((call) => call.input['reply_to_message_id']),
  );
  const pending = [...conversation.text.matchAll(FRAME)].find(
    (frame) =>
      frame[2] !== undefined &&
      !replied.has(frame[2]) &&
      !(frame[3] ?? '').trim().startsWith(SILENT),
  );
  if (reachable && pending?.[2] !== undefined) {
    return {
      kind: 'concord',
      operation: 'update_work',
      input: withId({
        operation: 'reply',
        reply_to_message_id: pending[2],
        content: `ACK ${(pending[3] ?? '').trim()}`,
        idempotency_key: `ack-${pending[2]}`,
      }),
    };
  }

  if (reachable && calledTool(conversation, 'start_work').length === 0) {
    return {
      kind: 'concord',
      operation: 'start_work',
      input: withId({
        task_id: `fake-model-${agentId ?? 'agent'}`,
        title: 'Fake model task',
        kind: 'e2e',
      }),
    };
  }

  const tell = /tell (\S+): (\S+)/u.exec(conversation.prompt);
  const prompted = calledTool(conversation, 'update_work').some(
    (call) => call.input['operation'] === 'prompt',
  );
  if (reachable && tell?.[1] !== undefined && tell[2] !== undefined && !prompted) {
    return {
      kind: 'concord',
      operation: 'update_work',
      input: withId({
        operation: 'prompt',
        to_agent_id: tell[1],
        content: tell[2],
        idempotency_key: `tell-${tell[2]}`,
      }),
    };
  }

  const monitor = [...conversation.text.matchAll(MONITOR_ASK)].at(-1)?.[1];
  if (monitor !== undefined && calledTool(conversation, 'monitor').length === 0) {
    return { kind: 'monitor', command: monitor };
  }

  if (
    conversation.prompt.includes('ask the user') &&
    conversation.tools.includes(ASK_USER) &&
    calledTool(conversation, ASK_USER).length === 0
  ) {
    return {
      kind: 'tool',
      name: ASK_USER,
      input: {
        questions: [
          {
            question: 'Proceed with the plan?',
            header: 'Proceed',
            multiSelect: false,
            options: [
              { label: 'Yes', description: 'Go ahead' },
              { label: 'No', description: 'Stop here' },
            ],
          },
        ],
      },
    };
  }

  const sleep = /run sleep (\d+)/u.exec(conversation.prompt)?.[1];
  if (sleep !== undefined && !conversation.calls.some((call) => isShell(call.name))) {
    return { kind: 'shell', command: `sleep ${sleep}` };
  }

  return { kind: 'text', text: 'Done.' };
}

/** Shell tools across harnesses. */
export function isShell(tool: string): boolean {
  return [
    'Bash',
    'bash',
    'run_terminal_command',
    'exec_command',
    'developer__shell',
    'shell',
  ].includes(tool);
}
