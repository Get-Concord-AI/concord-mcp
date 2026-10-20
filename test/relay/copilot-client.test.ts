import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CopilotUiServerClient,
  decodeFrames,
  encodeFrame,
  parseServerAddress,
} from '../../src/relay/copilot-client.js';

const requestSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.json()),
});
type Request = z.infer<typeof requestSchema>;

/** A stand-in for Copilot's `--ui-server` listener that records requests. */
async function fakeServer(
  respond: (request: Request, socket: Socket) => void,
): Promise<{ server: Server; address: string; requests: Request[] }> {
  const requests: Request[] = [];
  const server = createServer((socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      const decoded = decodeFrames(Buffer.concat([buffer, chunk]));
      buffer = decoded.rest;
      for (const body of decoded.bodies) {
        const raw: unknown = JSON.parse(body);
        const request = requestSchema.parse(raw);
        requests.push(request);
        respond(request, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = z
    .object({ port: z.number() })
    .parse(server.address() satisfies AddressInfo | string | null);
  return { server, address: `127.0.0.1:${String(port)}`, requests };
}

function reply(socket: Socket, id: number, result: z.core.util.JSONType): void {
  socket.write(encodeFrame({ jsonrpc: '2.0', id, result }));
}

function sessionEvent(socket: Socket, sessionId: string, type: string): void {
  socket.write(
    encodeFrame({
      jsonrpc: '2.0',
      method: 'session.event',
      params: { sessionId, event: { type } },
    }),
  );
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('Copilot ui-server framing', () => {
  it('round-trips Content-Length frames and keeps a partial one buffered', () => {
    const frames = encodeFrame({ id: 1 }) + encodeFrame({ id: 2, text: 'héllo' });
    const whole = Buffer.from(frames);
    const { bodies, rest } = decodeFrames(whole.subarray(0, whole.length - 3));
    expect(bodies).toEqual(['{"id":1}']);
    expect(decodeFrames(Buffer.concat([rest, whole.subarray(whole.length - 3)])).bodies).toEqual([
      '{"id":2,"text":"héllo"}',
    ]);
  });

  it('parses the launcher address and rejects anything else', () => {
    expect(parseServerAddress('127.0.0.1:47125')).toEqual({ host: '127.0.0.1', port: 47125 });
    expect(() => parseServerAddress('127.0.0.1')).toThrow('Invalid Copilot server address');
    expect(() => parseServerAddress('127.0.0.1:99999')).toThrow('Invalid Copilot server address');
  });
});

describe('CopilotUiServerClient', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
  });

  it('resumes only by id, then starts idle turns and steers busy ones', async () => {
    const fake = await fakeServer((request, socket) => {
      reply(
        socket,
        request.id,
        request.method === 'session.send' ? { messageId: 'm-1' } : { ok: true },
      );
    });
    server = fake.server;
    const client = new CopilotUiServerClient(fake.address, 'sess-1');
    await client.connect();

    expect(fake.requests.map((request) => request.method)).toEqual(['connect', 'session.resume']);
    expect(fake.requests[1]?.params).toEqual({ sessionId: 'sess-1' });

    expect(await client.pushPrompt('hello', 'inject')).toBe('m-1');
    await client.pushPrompt('more', 'steer');
    expect(fake.requests.slice(2).map((request) => request.params)).toEqual([
      { sessionId: 'sess-1', prompt: 'hello', mode: 'enqueue' },
      { sessionId: 'sess-1', prompt: 'more', mode: 'immediate' },
    ]);
    client.close();
  });

  it("follows this session's turns from its events", async () => {
    let peer: Socket | undefined;
    const fake = await fakeServer((request, socket) => {
      peer = socket;
      reply(socket, request.id, { ok: true });
    });
    server = fake.server;
    const client = new CopilotUiServerClient(fake.address, 'sess-1');
    await client.connect();
    if (peer === undefined) throw new Error('no connection');

    expect(client.isBusy()).toBe(false);
    sessionEvent(peer, 'sess-1', 'assistant.turn_start');
    await settle();
    expect(client.isBusy()).toBe(true);
    sessionEvent(peer, 'other-session', 'session.idle');
    await settle();
    expect(client.isBusy()).toBe(true);
    sessionEvent(peer, 'sess-1', 'session.idle');
    await settle();
    expect(client.isBusy()).toBe(false);
    client.close();
  });

  it('surfaces server errors and reports when the TUI goes away', async () => {
    const fake = await fakeServer((request, socket) => {
      if (request.method === 'session.send') {
        socket.write(
          encodeFrame({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32603, message: 'Session not found' },
          }),
        );
        socket.end();
        return;
      }
      reply(socket, request.id, { ok: true });
    });
    server = fake.server;
    const client = new CopilotUiServerClient(fake.address, 'sess-1');
    await client.connect();
    const closed = new Promise<void>((resolve) => {
      client.onClosed(resolve);
    });

    await expect(client.pushPrompt('hello', 'inject')).rejects.toThrow('Session not found');
    await closed;
  });
});
