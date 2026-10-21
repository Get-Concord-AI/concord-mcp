import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { anthropicConversation, anthropicRequestSchema, anthropicResponse } from './anthropic.js';
import { decide, type Conversation } from './brain.js';
import { resolve, type Step } from './resolve.js';
import { responsesConversation, responsesRequestSchema, responsesStream } from './responses.js';

/** One model call: what the harness showed the model and what it did. */
export interface ModelTurn {
  dialect: 'anthropic' | 'responses';
  conversation: Conversation;
  step: Step;
}

/**
 * A local stand-in for a model provider that real harness binaries are
 * pointed at. It speaks the Anthropic Messages and OpenAI Responses APIs,
 * decides each step with the scripted brain, and records every turn.
 */
export class FakeModel {
  readonly turns: ModelTurn[] = [];
  private counter = 0;

  private constructor(private readonly server: Server) {}

  static async start(): Promise<FakeModel> {
    // The handler needs the model, and the model needs the listening server.
    const holder: { model?: FakeModel } = {};
    const server = createServer((request, response) => {
      holder.model?.handle(request, response);
    });
    await new Promise<void>((resolvePromise) => {
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const model = new FakeModel(server);
    holder.model = model;
    return model;
  }

  /** Base URL including `/v1`, as providers are configured. */
  get baseUrl(): string {
    const address: AddressInfo | string | null = this.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Fake model is not listening.');
    return `http://127.0.0.1:${String(address.port)}/v1`;
  }

  /** Base URL without `/v1`, for clients that append it themselves. */
  get origin(): string {
    return this.baseUrl.replace(/\/v1$/u, '');
  }

  /** Concord tool calls the model made, e.g. `update_work`, in order. */
  concordCalls(operation: string): Step[] {
    return this.turns
      .map((turn) => turn.step)
      .filter(
        (step) =>
          step.kind === 'tool' &&
          (step.name.endsWith(operation) || step.input['tool_name'] === `concord__${operation}`),
      );
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolvePromise) => {
      this.server.close(() => {
        resolvePromise();
      });
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        this.answer(request.url ?? '', raw, response);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      }
    });
  }

  private answer(url: string, raw: string, response: ServerResponse): void {
    const id = `${String(Date.now())}${String((this.counter += 1))}`;
    if (url.includes('/messages') && !url.includes('count_tokens')) {
      const parsed = anthropicRequestSchema.parse(JSON.parse(raw));
      const conversation = anthropicConversation(parsed);
      const step = resolve(decide(conversation), conversation.tools);
      this.turns.push({ dialect: 'anthropic', conversation, step });
      const { contentType, body } = anthropicResponse(parsed, step, id);
      response.writeHead(200, { 'content-type': contentType });
      response.end(body);
      return;
    }
    if (url.includes('/responses')) {
      const parsed = responsesRequestSchema.parse(JSON.parse(raw));
      const conversation = responsesConversation(parsed);
      const step = resolve(decide(conversation), conversation.tools);
      this.turns.push({ dialect: 'responses', conversation, step });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(responsesStream(parsed, step, id));
      return;
    }
    // Token counts, model lists, and start-up pings get the smallest valid answer.
    response.writeHead(200, { 'content-type': 'application/json' });
    if (url.includes('count_tokens')) response.end('{"input_tokens":10}');
    else if (url.includes('/models'))
      response.end('{"object":"list","data":[{"id":"fake-model","object":"model"}]}');
    else response.end('{}');
  }
}
