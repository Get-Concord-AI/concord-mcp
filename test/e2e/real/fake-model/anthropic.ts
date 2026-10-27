import { z } from 'zod';

import type { JsonObject } from '../../support/mcp.js';
import type { Conversation, ToolCall } from './brain.js';
import type { Step } from './resolve.js';

/**
 * The Anthropic Messages API (`POST /v1/messages`), as Claude Code, Grok
 * (`api_backend = "messages"`), and Goose's Anthropic provider call it.
 */

const jsonObject = z.record(z.string(), z.json());

const blockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    name: z.string().optional(),
    input: jsonObject.optional(),
    content: z
      .union([z.string(), z.array(z.object({ text: z.string().optional() }).loose())])
      .optional(),
  })
  .loose();

const messageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(blockSchema)]),
});

export const anthropicRequestSchema = z
  .object({
    model: z.string().optional(),
    stream: z.boolean().optional(),
    system: z
      .union([z.string(), z.array(z.object({ text: z.string().optional() }).loose())])
      .optional(),
    tools: z.array(z.object({ name: z.string() }).loose()).optional(),
    messages: z.array(messageSchema),
  })
  .loose();
export type AnthropicRequest = z.infer<typeof anthropicRequestSchema>;

type Block = z.infer<typeof blockSchema>;

function blockText(block: Block): string {
  if (block.text !== undefined) return block.text;
  if (typeof block.content === 'string') return block.content;
  return (block.content ?? []).map((part) => part.text ?? '').join('\n');
}

function contentText(content: string | readonly Block[]): string {
  return typeof content === 'string' ? content : content.map(blockText).join('\n');
}

/** Grok reaches MCP tools through `use_tool`; count that as a call of the inner tool. */
function unwrap(block: Block): ToolCall {
  const input: JsonObject = block.input ?? {};
  if (block.name === 'use_tool') {
    const inner = z
      .object({ tool_name: z.string(), tool_input: jsonObject.optional() })
      .safeParse(input);
    if (inner.success) return { name: inner.data.tool_name, input: inner.data.tool_input ?? {} };
  }
  return { name: block.name ?? '', input };
}

function opensTurn(last: z.infer<typeof messageSchema> | undefined): boolean {
  if (last?.role !== 'user') return false;
  return (
    typeof last.content === 'string' || !last.content.some((block) => block.type === 'tool_result')
  );
}

export function anthropicConversation(request: AnthropicRequest): Conversation {
  const calls = request.messages
    .filter((message) => message.role === 'assistant' && typeof message.content !== 'string')
    .flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : message.content.filter((block) => block.type === 'tool_use').map(unwrap),
    );
  const userMessages = request.messages.filter((message) => message.role === 'user');
  return {
    tools: (request.tools ?? []).map((tool) => tool.name),
    calls,
    text: userMessages.map((message) => contentText(message.content)).join('\n'),
    // Harnesses put their own context (environment, rules) before or beside
    // the prompt, so instructions are read from every user message.
    prompt: userMessages.map((message) => contentText(message.content)).join('\n'),
    opensTurn: opensTurn(request.messages.at(-1)),
  };
}

/** The response body (JSON) or SSE event stream for one step. */
export function anthropicResponse(
  request: AnthropicRequest,
  step: Step,
  id: string,
): { contentType: string; body: string } {
  const toolUse = step.kind === 'tool';
  const block = toolUse
    ? { type: 'tool_use', id: `toolu_${id}`, name: step.name, input: step.input }
    : { type: 'text', text: step.text };
  const message = {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    model: request.model ?? 'fake-model',
    stop_reason: toolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  if (request.stream !== true) {
    return {
      contentType: 'application/json',
      body: JSON.stringify({ ...message, content: [block] }),
    };
  }
  const opening = toolUse ? { ...block, input: {} } : { type: 'text', text: '' };
  const delta = toolUse
    ? { type: 'input_json_delta', partial_json: JSON.stringify(step.input) }
    : { type: 'text_delta', text: step.text };
  const events: [string, object][] = [
    [
      'message_start',
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: opening }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return {
    contentType: 'text/event-stream',
    body: events
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join(''),
  };
}
