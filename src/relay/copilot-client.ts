import { connect, type Socket } from 'node:net';

import { z } from 'zod';

import type { PushPromptSession } from './adapters.js';

/**
 * JSON-RPC client for Copilot CLI's TUI + server mode (`copilot --ui-server`).
 *
 * The embedded server speaks JSON-RPC 2.0 with `Content-Length` framing over
 * loopback TCP, the protocol the Copilot SDK uses. A connection must
 * `session.resume` a session before it may `session.send` to it; the resume
 * passes only the id, so the user's model, tools, and system message are left
 * as the TUI set them. Resuming also streams the session's events, which is
 * how this client knows whether a turn is running (issue #261).
 */

const responseSchema = z
  .object({
    id: z.number(),
    result: z.json().optional(),
    error: z.object({ message: z.string() }).loose().optional(),
  })
  .loose();
const sessionEventSchema = z
  .object({
    method: z.literal('session.event'),
    params: z
      .object({
        sessionId: z.string().optional(),
        event: z.object({ type: z.string() }).loose(),
      })
      .loose(),
  })
  .loose();
const sendResultSchema = z.object({ messageId: z.string() }).loose();

/** Events that mean the session is working on a turn, and the one that means it stopped. */
const BUSY_EVENTS: ReadonlySet<string> = new Set(['user.message', 'assistant.turn_start']);
const IDLE_EVENT = 'session.idle';

type RpcResult = z.infer<typeof responseSchema>['result'];

interface PendingRequest {
  resolve(value: RpcResult): void;
  reject(error: Error): void;
}

/** Split `host:port` (the value the launcher exports) into its parts. */
export function parseServerAddress(address: string): { host: string; port: number } {
  const match = /^(?<host>[^:]+):(?<port>\d+)$/u.exec(address.trim());
  const port = Number(match?.groups?.['port']);
  const host = match?.groups?.['host'];
  if (host === undefined || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid Copilot server address: ${address}`);
  }
  return { host, port };
}

/** Encode one JSON-RPC message with its `Content-Length` header. */
export function encodeFrame(message: Record<string, unknown>): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`;
}

/** Pull every complete frame off the front of `buffer`; returns bodies and the remainder. */
export function decodeFrames(buffer: Buffer): { bodies: string[]; rest: Buffer } {
  const bodies: string[] = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const length = Number(
      /content-length:\s*(\d+)/iu.exec(rest.subarray(0, headerEnd).toString())?.[1],
    );
    if (!Number.isInteger(length))
      throw new Error('Copilot server sent a frame without Content-Length.');
    const start = headerEnd + 4;
    if (rest.length < start + length) break;
    bodies.push(rest.subarray(start, start + length).toString('utf8'));
    rest = rest.subarray(start + length);
  }
  return { bodies, rest };
}

/** One resumed Copilot session behind a `--ui-server` listener. */
export class CopilotUiServerClient implements PushPromptSession {
  private socket: Socket | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private busy = false;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closedListeners: (() => void)[] = [];

  constructor(
    private readonly address: string,
    private readonly sessionId: string,
  ) {}

  isBusy(): boolean {
    return this.busy;
  }

  /** Connect, attach to the session, and start following its turns. */
  async connect(): Promise<void> {
    const { host, port } = parseServerAddress(this.address);
    const socket = connect(port, host);
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on('close', () => {
      this.closed = true;
      this.failPending(new Error('Copilot server connection closed.'));
      for (const listener of this.closedListeners) listener();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.on('error', () => undefined);
    await this.request('connect', { token: null, supportedTaskKinds: [] });
    await this.request('session.resume', { sessionId: this.sessionId });
  }

  /** Steer a running turn (`immediate`) or start a new one (`enqueue`). */
  async pushPrompt(content: string, mode: 'steer' | 'inject'): Promise<string | undefined> {
    const result = await this.request('session.send', {
      sessionId: this.sessionId,
      prompt: content,
      mode: mode === 'steer' ? 'immediate' : 'enqueue',
    });
    const parsed = sendResultSchema.safeParse(result);
    if (mode === 'inject') this.busy = true;
    return parsed.success ? parsed.data.messageId : undefined;
  }

  /**
   * Run `listener` once the server goes away (the TUI exited) — at once if it
   * already has, so a host that subscribes after a slow setup still stops.
   */
  onClosed(listener: () => void): void {
    if (this.closed) {
      listener();
      return;
    }
    this.closedListeners.push(listener);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private request(
    method: string,
    params: Record<string, z.core.util.JSONType>,
  ): Promise<RpcResult> {
    const socket = this.socket;
    if (socket === undefined) return Promise.reject(new Error('Copilot server is not connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  private onData(chunk: Buffer): void {
    let decoded: ReturnType<typeof decodeFrames>;
    try {
      decoded = decodeFrames(Buffer.concat([this.buffer, chunk]));
    } catch (error) {
      this.failPending(error instanceof Error ? error : new Error(String(error)));
      this.close();
      return;
    }
    this.buffer = decoded.rest;
    for (const body of decoded.bodies) this.onMessage(body);
  }

  private onMessage(body: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return;
    }
    const event = sessionEventSchema.safeParse(raw);
    if (event.success) {
      const { sessionId, event: sessionEvent } = event.data.params;
      if (sessionId !== undefined && sessionId !== this.sessionId) return;
      if (BUSY_EVENTS.has(sessionEvent.type)) this.busy = true;
      if (sessionEvent.type === IDLE_EVENT) this.busy = false;
      return;
    }
    const response = responseSchema.safeParse(raw);
    if (!response.success) return;
    const pending = this.pending.get(response.data.id);
    if (pending === undefined) return;
    this.pending.delete(response.data.id);
    if (response.data.error !== undefined) pending.reject(new Error(response.data.error.message));
    else pending.resolve(response.data.result);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
