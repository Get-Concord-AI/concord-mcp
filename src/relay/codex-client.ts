import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { type ClientRequestArgs } from 'node:http';
import { Duplex } from 'node:stream';

import WsWebSocket, { type RawData } from 'ws';
import { z } from 'zod';

import { VERSION } from '../version.js';
import { parseCodexNotification, type CodexNotification } from './codex-notifications.js';

const responseSchema = z
  .object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z.object({ message: z.string() }).loose().optional(),
  })
  .loose();

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

interface RpcSocket {
  send(data: string): void;
  close(): void;
}

function bufferFromChunk(chunk: unknown): Buffer | undefined {
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return undefined;
}

function rawText(data: RawData): string | undefined {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return undefined;
}

/** Stdio duplex for the WebSocket handshake: reads `child.stdout`, writes `child.stdin`. */
function proxyStdio(child: ChildProcessWithoutNullStreams): Duplex {
  const stream = new Duplex({
    read() {
      child.stdout.resume();
    },
    write(chunk, encoding, callback) {
      if (typeof chunk === 'string') {
        child.stdin.write(chunk, encoding, callback);
        return;
      }
      const buffer = bufferFromChunk(chunk);
      if (buffer === undefined) {
        callback(new Error('Unexpected Codex proxy write.'));
        return;
      }
      child.stdin.write(buffer, callback);
    },
  });
  child.stdout.on('data', (chunk: unknown) => {
    const buffer = bufferFromChunk(chunk);
    if (buffer === undefined) return;
    if (!stream.push(buffer)) child.stdout.pause();
  });
  child.stdout.on('end', () => {
    stream.push(null);
  });
  child.stdout.on('error', (error: Error) => {
    stream.destroy(error);
  });
  child.stdin.on('error', (error: Error) => {
    stream.destroy(error);
  });
  return stream;
}

/** WebSocket client for the Codex app-server, over the stdio proxy or a ws:// URL. */
export class CodexDaemonClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private socket: RpcSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private activeTurnId: string | undefined;
  private readonly listeners: ((notification: CodexNotification) => void)[] = [];

  constructor(
    private readonly command = 'codex',
    private readonly args: readonly string[] = ['app-server', 'proxy'],
    private readonly remoteUrl = process.env['CONCORD_CODEX_APP_SERVER_URL'],
    private readonly initializeTimeoutMs = DEFAULT_INITIALIZE_TIMEOUT_MS,
  ) {}

  currentTurnId(): string | undefined {
    return this.activeTurnId;
  }

  /** Receive every app-server notification (item and turn events). */
  onNotification(listener: (notification: CodexNotification) => void): void {
    this.listeners.push(listener);
  }

  async connect(): Promise<void> {
    if (this.child !== undefined || this.socket !== undefined) return;
    if (this.remoteUrl !== undefined && this.remoteUrl !== '') {
      await this.connectSocket(this.remoteUrl);
    } else {
      await this.connectProxy();
    }
    await this.request(
      'initialize',
      {
        clientInfo: { name: 'concord', title: 'Concord', version: VERSION },
        capabilities: { experimentalApi: true },
      },
      this.initializeTimeoutMs,
    );
    this.notify('initialized', {});
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request('thread/resume', { threadId });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.child === undefined && this.socket === undefined) {
      return Promise.reject(new Error('Codex app-server is not connected.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.failPending(id, this.timeoutError(timeoutMs));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.send({ id, method, params });
    });
  }

  close(): void {
    this.child?.kill();
    this.socket?.close();
    this.child = undefined;
    this.socket = undefined;
  }

  private timeoutError(timeoutMs: number): Error {
    const target = [this.command, ...this.args].join(' ');
    return new Error(
      `Codex app-server initialize timed out after ${String(timeoutMs)}ms (${target}).`,
    );
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(message));
  }

  private async connectSocket(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const fail = (): void => {
        reject(new Error(`Unable to connect to Codex app-server at ${url}.`));
      };
      socket.addEventListener(
        'open',
        () => {
          this.socket = socket;
          resolve();
        },
        { once: true },
      );
      socket.addEventListener('error', fail, { once: true });
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') this.onFrame(event.data);
      });
      socket.addEventListener('close', () => {
        this.failAll(new Error('Codex app-server WebSocket closed.'));
      });
    });
  }

  private connectProxy(): Promise<void> {
    const child = spawn(this.command, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.resume();
    child.once('error', (error) => {
      this.failAll(error);
    });
    child.once('exit', (code) => {
      this.failAll(new Error(`Codex app-server exited (${String(code)}).`));
    });
    const stream = proxyStdio(child);
    const options: ClientRequestArgs = {
      createConnection: () => stream,
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(this.timeoutError(this.initializeTimeoutMs));
        this.close();
      }, this.initializeTimeoutMs);
      const socket = new WsWebSocket('ws://127.0.0.1', {
        ...options,
        perMessageDeflate: false,
      });
      socket.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once('error', (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
        this.close();
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = rawText(data);
        if (text !== undefined) this.onFrame(text);
      });
      socket.on('close', () => {
        this.failAll(new Error('Codex app-server WebSocket closed.'));
      });
    });
  }

  private onFrame(frame: string): void {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      return;
    }
    const response = responseSchema.safeParse(value);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      if (pending === undefined) return;
      this.dropPending(response.data.id, pending);
      if (response.data.error !== undefined) pending.reject(new Error(response.data.error.message));
      else pending.resolve(response.data.result);
      return;
    }
    const notification = parseCodexNotification(value);
    if (notification === undefined) return;
    for (const listener of this.listeners) listener(notification);
    if (notification.method === 'turn/started') this.activeTurnId = notification.turn.id;
    if (notification.method === 'turn/completed' && this.activeTurnId === notification.turn.id) {
      this.activeTurnId = undefined;
    }
  }

  private failPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.dropPending(id, pending);
    pending.reject(error);
    this.close();
  }

  private dropPending(id: number, pending: PendingRequest): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.pending.delete(id);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.dropPending(id, pending);
      pending.reject(error);
    }
    this.child = undefined;
    this.socket = undefined;
  }
}
