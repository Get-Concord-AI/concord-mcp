import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

import type { McpServerSpec } from './installed.js';

export type JsonValue = z.infer<ReturnType<typeof z.json>>;
export type JsonObject = Record<string, JsonValue>;

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.json()).optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
});

export class ToolCallError extends Error {
  constructor(
    readonly tool: string,
    readonly detail: string,
  ) {
    super(`${tool} failed: ${detail}`);
    this.name = 'ToolCallError';
  }
}

/** A real stdio MCP connection to the installed Concord server, as a harness opens it. */
export class McpSession {
  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  static async connect(
    spec: McpServerSpec,
    options: { cwd: string; env: Record<string, string> },
  ): Promise<McpSession> {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      cwd: options.cwd,
      env: { ...options.env, ...spec.env },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'concord-e2e', version: '0.0.0' });
    await client.connect(transport);
    return new McpSession(client, transport);
  }

  async toolNames(): Promise<string[]> {
    const listed = await this.client.listTools();
    return listed.tools.map((tool) => tool.name);
  }

  /** Call a tool and parse its structured result with `schema`. */
  async call<T>(tool: string, args: JsonObject, schema: z.ZodType<T>): Promise<T> {
    const raw: unknown = await this.client.callTool({ name: tool, arguments: args });
    const result = toolResultSchema.parse(raw);
    const text = result.content
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
    if (result.isError === true) throw new ToolCallError(tool, text);
    if (result.structuredContent === undefined) throw new ToolCallError(tool, `no result: ${text}`);
    return schema.parse(result.structuredContent);
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.transport.close();
  }
}
