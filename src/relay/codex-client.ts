import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

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

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  return '';
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** JSONL client for the managed Codex app-server daemon's stdio proxy. */
export class CodexDaemonClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private socket: WebSocket | undefined;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, PendingRequest>();
  private activeTurnId: string | undefined;
  private readonly listeners: ((notification: CodexNotification) => void)[] = [];

  constructor(
    private readonly command = 'codex',
    private readonly args: readonly string[] = ['app-server', 'proxy'],
    private readonly remoteUrl = process.env['CONCORD_CODEX_APP_SERVER_URL'],
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
      const child = spawn(this.command, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.on('data', (chunk: unknown) => {
        this.onData(chunkText(chunk));
      });
      child.stderr.resume();
      child.once('error', (error) => {
        this.failAll(error);
      });
      child.once('exit', (code) => {
        this.failAll(new Error(`Codex app-server exited (${String(code)}).`));
      });
    }
    await this.request('initialize', {
      clientInfo: { name: 'concord', title: 'Concord', version: VERSION },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request('thread/resume', { threadId });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.child === undefined && this.socket === undefined) {
      return Promise.reject(new Error('Codex app-server is not connected.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  close(): void {
    this.child?.kill();
    this.socket?.close();
    this.child = undefined;
    this.socket = undefined;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: Record<string, unknown>): void {
    const frame = JSON.stringify(message);
    if (this.socket !== undefined) this.socket.send(frame);
    else this.child?.stdin.write(`${frame}\n`);
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

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const frame = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (frame !== '') this.onFrame(frame);
      newline = this.buffer.indexOf('\n');
    }
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
      this.pending.delete(response.data.id);
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

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.child = undefined;
    this.socket = undefined;
  }
}
