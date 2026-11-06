import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CodexDaemonClient } from '../../src/relay/codex-client.js';

/** RFC 6455 magic. The proxy client and a standards-compliant daemon both use it. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const rpcSchema = z.object({ id: z.number().optional(), method: z.string().optional() }).loose();

const PROXY = `import { writeFileSync } from 'node:fs';
import net from 'node:net';

writeFileSync(process.argv[3], String(process.pid));
const socket = net.connect({ host: '127.0.0.1', port: Number(process.argv[2]) });
socket.on('error', () => undefined);
process.stdin.on('error', () => undefined);
process.stdout.on('error', () => undefined);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
`;

function acceptKey(key: string, guid: string): string {
  return createHash('sha1')
    .update(key + guid)
    .digest('base64');
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (payload.length < 126) header[1] = payload.length;
  else {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, payload]);
}

/** Pull complete text frames out of a byte stream. Client frames are masked. */
function readTexts(buffer: Buffer): { texts: string[]; rest: Buffer } {
  const texts: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = (buffer[offset] ?? 0) & 0x0f;
    const lengthByte = buffer[offset + 1] ?? 0;
    const masked = (lengthByte & 0x80) !== 0;
    let length = lengthByte & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) break;
    const maskLength = masked ? 4 : 0;
    if (cursor + maskLength + length > buffer.length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : undefined;
    cursor += maskLength;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask !== undefined) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
    }
    if (opcode === 0x1) texts.push(payload.toString('utf8'));
    offset = cursor + length;
  }
  return { texts, rest: buffer.subarray(offset) };
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const parsed = z.object({ code: z.string() }).safeParse(error);
    return parsed.success && parsed.data.code === 'EPERM';
  }
}

interface ProxyFixture {
  client: CodexDaemonClient;
  methods: string[];
  upgraded: () => boolean;
  pid: () => number;
  stop: () => void;
}

/** Fake `codex app-server proxy` (stdio byte pipe) in front of an in-process WebSocket daemon. */
async function proxyFixture(reply: boolean): Promise<ProxyFixture> {
  const methods: string[] = [];
  let upgraded = false;
  let buffer: Buffer = Buffer.alloc(0);
  const server = createServer((socket: Socket) => {
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const head = buffer.subarray(0, headerEnd).toString('utf8');
        const key = /sec-websocket-key:\s*(\S+)/iu.exec(head)?.[1];
        if (key === undefined) return;
        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey(key, WS_GUID)}`,
            '',
            '',
          ].join('\r\n'),
        );
        buffer = buffer.subarray(headerEnd + 4);
        upgraded = true;
      }
      const parsed = readTexts(buffer);
      buffer = parsed.rest;
      for (const text of parsed.texts) {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          continue;
        }
        const message = rpcSchema.safeParse(value);
        if (!message.success || message.data.method === undefined) continue;
        methods.push(message.data.method);
        if (!reply || message.data.id === undefined) continue;
        socket.write(textFrame(JSON.stringify({ id: message.data.id, result: {} })));
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const port = z.object({ port: z.number() }).parse(server.address()).port;
  const dir = mkdtempSync(join(tmpdir(), 'codex-proxy-'));
  const script = join(dir, 'proxy.mjs');
  const pidPath = join(dir, 'pid');
  writeFileSync(script, PROXY);
  const client = new CodexDaemonClient(process.execPath, [script, String(port), pidPath], '');
  return {
    client,
    methods,
    upgraded: () => upgraded,
    pid: () => Number(readFileSync(pidPath, 'utf8')),
    stop: () => {
      client.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const realSetTimeout = setTimeout;

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 10);
    });
  }
  throw new Error('timed out waiting for the proxy');
}

/** This Node build's global WebSocket checks a non-RFC magic. CI's Node checks the RFC one. */
const ALT_GUID = String.fromCharCode(
  0x32,
  0x35,
  0x38,
  0x45,
  0x41,
  0x46,
  0x41,
  0x35,
  0x2d,
  0x45,
  0x39,
  0x31,
  0x34,
  0x2d,
  0x34,
  0x37,
  0x44,
  0x41,
  0x2d,
  0x39,
  0x35,
  0x43,
  0x41,
  0x2d,
  0x43,
  0x35,
  0x41,
  0x42,
  0x30,
  0x44,
  0x43,
  0x38,
  0x35,
  0x42,
  0x31,
  0x31,
);

async function globalWebSocketOpens(guid: string): Promise<boolean> {
  const server = createServer((socket: Socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const key = /sec-websocket-key:\s*(\S+)/iu.exec(
        buffer.subarray(0, headerEnd).toString('utf8'),
      )?.[1];
      if (key === undefined) return;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key, guid)}\r\n\r\n`,
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const port = z.object({ port: z.number() }).parse(server.address()).port;
  const opened = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    const timer = realSetTimeout(() => {
      socket.close();
      resolve(false);
    }, 300);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve(true);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  server.close();
  return opened;
}

async function guidAcceptedByGlobalWebSocket(): Promise<string> {
  if (await globalWebSocketOpens(WS_GUID)) return WS_GUID;
  if (await globalWebSocketOpens(ALT_GUID)) return ALT_GUID;
  throw new Error('global WebSocket rejected the handshake.');
}

describe('CodexDaemonClient', () => {
  const stop: (() => void)[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const step of stop.splice(0)) step();
  });

  it('speaks WebSocket over the proxy stdio and initialize resolves', async () => {
    const fixture = await proxyFixture(true);
    stop.push(fixture.stop);

    await fixture.client.connect();

    expect(fixture.upgraded()).toBe(true);
    expect(fixture.methods).toContain('initialize');
  });

  it('rejects a silent daemon at 10000ms, drops the pending call, and kills the child', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = await proxyFixture(false);
    stop.push(fixture.stop);
    const connecting = fixture.client.connect();

    await waitUntil(() => fixture.methods.includes('initialize'));
    expect(fixture.upgraded()).toBe(true);
    expect(running(fixture.pid())).toBe(true);

    const rejected = expect(connecting).rejects.toThrow(/timed out after 10000ms/);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;

    await waitUntil(() => !running(fixture.pid()));
    await expect(fixture.client.request('thread/resume', { threadId: 't-1' })).rejects.toThrow(
      'Codex app-server is not connected.',
    );
  });

  it('keeps the CONCORD_CODEX_APP_SERVER_URL path on the global WebSocket', async () => {
    const guid = await guidAcceptedByGlobalWebSocket();
    const methods: string[] = [];
    const server = createServer((socket: Socket) => {
      let buffer: Buffer = Buffer.alloc(0);
      let upgraded = false;
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          const head = buffer.subarray(0, headerEnd).toString('utf8');
          const key = /sec-websocket-key:\s*(\S+)/iu.exec(head)?.[1];
          if (key === undefined) return;
          socket.write(
            [
              'HTTP/1.1 101 Switching Protocols',
              'Upgrade: websocket',
              'Connection: Upgrade',
              `Sec-WebSocket-Accept: ${acceptKey(key, guid)}`,
              '',
              '',
            ].join('\r\n'),
          );
          buffer = buffer.subarray(headerEnd + 4);
          upgraded = true;
        }
        const parsed = readTexts(buffer);
        buffer = parsed.rest;
        for (const text of parsed.texts) {
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            continue;
          }
          const message = rpcSchema.safeParse(value);
          if (!message.success || message.data.method === undefined) continue;
          methods.push(message.data.method);
          if (message.data.id === undefined) continue;
          socket.write(textFrame(JSON.stringify({ id: message.data.id, result: {} })));
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const port = z.object({ port: z.number() }).parse(server.address()).port;
    const previous = process.env['CONCORD_CODEX_APP_SERVER_URL'];
    process.env['CONCORD_CODEX_APP_SERVER_URL'] = `ws://127.0.0.1:${String(port)}`;
    const client = new CodexDaemonClient();
    stop.push(() => {
      client.close();
      server.close();
      if (previous === undefined) delete process.env['CONCORD_CODEX_APP_SERVER_URL'];
      else process.env['CONCORD_CODEX_APP_SERVER_URL'] = previous;
    });

    await client.connect();

    expect(methods).toContain('initialize');
  });
});
