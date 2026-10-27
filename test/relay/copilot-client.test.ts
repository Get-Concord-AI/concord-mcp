import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
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
      reply(
        socket,
        request.id,
        request.method === 'session.send' ? { messageId: 'm' } : { ok: true },
      );
    });
    server = fake.server;
    const client = new CopilotUiServerClient(fake.address, 'sess-1');
    await client.connect();
    if (peer === undefined) throw new Error('no connection');
    const connection = peer;
    // A steer's reply follows every earlier frame on the socket, so once it
    // resolves the events sent before it have been handled — no timing guess.
    const afterEvents = (...types: [string, string][]): Promise<string | undefined> => {
      for (const [sessionId, type] of types) sessionEvent(connection, sessionId, type);
      return client.pushPrompt('sync', 'steer');
    };

    expect(client.isBusy()).toBe(false);
    await afterEvents(['sess-1', 'assistant.turn_start']);
    expect(client.isBusy()).toBe(true);
    await afterEvents(['other-session', 'session.idle']);
    expect(client.isBusy()).toBe(true);
    await afterEvents(['sess-1', 'session.idle']);
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

  it('stops a host that subscribes after the TUI already exited', async () => {
    const fake = await fakeServer((request, socket) => {
      if (socket.writableEnded) return;
      reply(socket, request.id, { ok: true });
      if (request.method === 'session.resume') socket.end();
    });
    server = fake.server;
    const client = new CopilotUiServerClient(fake.address, 'sess-1');
    await client.connect();
    // Wait for the close itself, then subscribe late.
    await vi.waitFor(async () => {
      await expect(client.pushPrompt('probe', 'steer')).rejects.toThrow();
    });

    let stopped = false;
    client.onClosed(() => {
      stopped = true;
    });
    expect(stopped).toBe(true);
  });
});
