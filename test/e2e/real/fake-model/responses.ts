import { z } from 'zod';

import type { JsonObject } from '../../support/mcp.js';
import type { Conversation, ToolCall } from './brain.js';
import type { Step } from './resolve.js';

/**
 * The OpenAI Responses API (`POST /v1/responses`), as Codex calls it through a
 * custom `model_providers` entry. Codex groups each MCP server's tools under a
 * `namespace` tool, and a call names both the namespace and the tool.
 */

const toolSchema = z
  .object({
    type: z.string().optional(),
    name: z.string().optional(),
    tools: z.array(z.object({ name: z.string() }).loose()).optional(),
  })
  .loose();

const itemSchema = z
  .object({
    type: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    namespace: z.string().optional(),
    arguments: z.string().optional(),
    output: z.union([z.string(), z.json()]).optional(),
    content: z
      .union([z.string(), z.array(z.object({ text: z.string().optional() }).loose())])
      .optional(),
  })
  .loose();

export const responsesRequestSchema = z
  .object({
    model: z.string().optional(),
    tools: z.array(toolSchema).optional(),
    input: z.union([z.string(), z.array(itemSchema)]),
  })
  .loose();
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

type Item = z.infer<typeof itemSchema>;

function itemText(item: Item): string {
  if (typeof item.content === 'string') return item.content;
  if (item.content !== undefined) return item.content.map((part) => part.text ?? '').join('\n');
  if (item.type === 'function_call_output') {
    return typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
  }
  return '';
}

function call(item: Item): ToolCall {
  const name =
    item.namespace === undefined ? (item.name ?? '') : `${item.namespace}/${item.name ?? ''}`;
  let input: JsonObject = {};
  try {
    const parsed = z.record(z.string(), z.json()).safeParse(JSON.parse(item.arguments ?? '{}'));
    if (parsed.success) input = parsed.data;
  } catch {
    // A call whose arguments are not JSON counts with no input.
  }
  return { name, input };
}

export function responsesConversation(request: ResponsesRequest): Conversation {
  const items: Item[] =
    typeof request.input === 'string'
      ? [{ type: 'message', role: 'user', content: request.input }]
      : request.input;
  const tools = (request.tools ?? []).flatMap((tool) =>
    tool.type === 'namespace'
      ? (tool.tools ?? []).map((inner) => `${tool.name ?? ''}/${inner.name}`)
      : [tool.name ?? tool.type ?? ''],
  );
  const said = items.filter((item) => item.type !== 'function_call');
  const prompts = items.filter((item) => item.type === 'message' && item.role === 'user');
  return {
    tools,
    calls: items.filter((item) => item.type === 'function_call').map(call),
    text: said.map(itemText).join('\n'),
    // Codex sends AGENTS.md and environment context as user messages first;
    // the scenario's instructions are in the latest real prompt.
    prompt: prompts.map(itemText).join('\n'),
  };
}

/** The SSE event stream Codex reads for one step. */
export function responsesStream(request: ResponsesRequest, step: Step, id: string): string {
  const item =
    step.kind === 'tool'
      ? {
          type: 'function_call',
          id: `fc_${id}`,
          call_id: `call_${id}`,
          ...(step.name.includes('/')
            ? { namespace: step.name.split('/')[0], name: step.name.split('/')[1] }
            : { name: step.name }),
          arguments: JSON.stringify(step.input),
          status: 'completed',
        }
      : {
          type: 'message',
          id: `msg_${id}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: step.text, annotations: [] }],
        };
  const response = {
    id: `resp_${id}`,
    object: 'response',
    status: 'completed',
    model: request.model ?? 'fake-model',
    output: [item],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const events: [string, object][] = [
    ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
    ['response.output_item.added', { output_index: 0, item }],
    ...(step.kind === 'text'
      ? [
          [
            'response.output_text.delta',
            { output_index: 0, content_index: 0, item_id: item.id, delta: step.text },
          ] satisfies [string, object],
        ]
      : []),
    ['response.output_item.done', { output_index: 0, item }],
    ['response.completed', { response }],
  ];
  return events
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    .join('');
}
