import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { InitializeRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

import type { TelemetryClient } from './client.js';

const responseSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    result: z.object({ isError: z.boolean().optional() }).passthrough().optional(),
    error: z.object({ code: z.number() }).passthrough().optional(),
  })
  .passthrough();
const callRequestSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    method: z.literal('tools/call'),
    params: z.object({ name: z.string() }).passthrough(),
  })
  .passthrough();

interface PendingCall {
  operation: string;
  startedAt: number;
}

/** Observes MCP envelopes without retaining tool arguments or response bodies. */
export class TelemetryTransport implements Transport {
  readonly #inner: Transport;
  readonly #telemetry: TelemetryClient;
  readonly #pending = new Map<string, PendingCall>();

  onclose: NonNullable<Transport['onclose']> = () => undefined;
  onerror: NonNullable<Transport['onerror']> = () => undefined;
  onmessage: NonNullable<Transport['onmessage']> = () => undefined;

  constructor(inner: Transport, telemetry: TelemetryClient) {
    this.#inner = inner;
    this.#telemetry = telemetry;
  }

  setProtocolVersion(version: string): void {
    this.#inner.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    this.#inner.onclose = () => {
      void this.#telemetry.close();
      this.onclose();
    };
    this.#inner.onerror = (error) => {
      this.onerror(error);
    };
    this.#inner.onmessage = (message, extra) => {
      this.#observeIncoming(message);
      this.onmessage(message, extra);
    };
    await this.#inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.#observeOutgoing(message);
    await this.#inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.#telemetry.close();
    await this.#inner.close();
  }

  #observeIncoming(message: JSONRPCMessage): void {
    const initialization = InitializeRequestSchema.safeParse(message);
    if (initialization.success) {
      this.#telemetry.setClientInfo(
        initialization.data.params.clientInfo.name,
        initialization.data.params.clientInfo.version,
      );
      return;
    }
    const call = callRequestSchema.safeParse(message);
    if (call.success) {
      this.#pending.set(String(call.data.id), {
        operation: call.data.params.name,
        startedAt: performance.now(),
      });
    }
  }

  #observeOutgoing(message: JSONRPCMessage): void {
    const response = responseSchema.safeParse(message);
    if (!response.success) {
      return;
    }
    const pending = this.#pending.get(String(response.data.id));
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(String(response.data.id));
    const failed = response.data.error !== undefined || response.data.result?.isError === true;
    this.#telemetry.recordOperation(
      pending.operation,
      failed ? 'error' : 'success',
      performance.now() - pending.startedAt,
    );
  }
}
