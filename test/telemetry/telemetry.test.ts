import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { createServer } from '../../src/server.js';
import { createTelemetryClient, TelemetryClient } from '../../src/telemetry/client.js';
import { loadTelemetryIdentity, workspacePseudonym } from '../../src/telemetry/identity.js';
import { TelemetryTransport } from '../../src/telemetry/transport.js';

const payloadSchema = z.object({
  installation_id: z.string(),
  session_id: z.string(),
  source: z.object({
    client_name: z.string().nullable(),
    client_version: z.string().nullable(),
  }),
  events: z.array(
    z.object({
      event_type: z.string(),
      operation: z.string().nullable(),
      workspace_id: z.string().nullable(),
    }),
  ),
});

function configRoot(): string {
  return mkdtempSync(join(tmpdir(), 'concord-telemetry-'));
}

describe('telemetry identity', () => {
  it('persists a random installation identity and derives opaque workspace ids', () => {
    const path = join(configRoot(), 'telemetry.json');
    const first = loadTelemetryIdentity(path);
    const second = loadTelemetryIdentity(path);
    expect(first).toBeDefined();
    expect(second).toEqual(first);
    if (first === undefined) {
      throw new Error('identity was not created');
    }
    const root = '/Users/private-user/Secret Client/repository';
    const pseudonym = workspacePseudonym(first, root);
    expect(pseudonym).toMatch(/^[0-9a-f]{64}$/u);
    expect(pseudonym).not.toContain('private-user');
    expect(readFileSync(path, 'utf8')).not.toContain(root);
  });
});

describe('telemetry client', () => {
  it('honours Concord and standard do-not-track opt-outs', () => {
    for (const env of [
      { CONCORD_TELEMETRY_DISABLED: '1' },
      { DO_NOT_TRACK: '1' },
      { NODE_ENV: 'test' },
    ]) {
      expect(
        createTelemetryClient({
          surface: 'cli',
          workspaceRoot: () => '/repo',
          env,
        }),
      ).toBeUndefined();
    }
  });

  it('sends only the narrow metadata contract and normalizes client identity', async () => {
    const bodies: string[] = [];
    const fetcher: typeof fetch = (_input, init) => {
      if (typeof init?.body === 'string') {
        bodies.push(init.body);
      }
      return Promise.resolve(new Response(null, { status: 202 }));
    };
    const sensitiveRoot = '/Users/alex/Very Secret Customer/repo';
    const telemetry = new TelemetryClient(randomUUID(), 'a'.repeat(64), {
      surface: 'mcp',
      workspaceRoot: () => sensitiveRoot,
      env: {},
      fetcher,
    });
    telemetry.setClientInfo('Internal Secret Client', 'secret version value');
    telemetry.recordOperation('claim_work', 'success', 12.4);
    await telemetry.close();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(sensitiveRoot);
    expect(bodies[0]).not.toContain('Internal Secret Client');
    expect(bodies[0]).not.toContain('secret version value');
    const payload = payloadSchema.parse(JSON.parse(bodies[0] ?? ''));
    expect(payload.source).toEqual({ client_name: 'other', client_version: null });
    expect(payload.events.map((event) => event.event_type)).toEqual([
      'session_started',
      'operation_completed',
    ]);
    expect(payload.events[1]?.operation).toBe('claim_work');
    expect(payload.events[0]?.workspace_id).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('observes MCP outcomes without changing transport behaviour', async () => {
    const bodies: string[] = [];
    const fetcher: typeof fetch = (_input, init) => {
      if (typeof init?.body === 'string') {
        bodies.push(init.body);
      }
      return Promise.resolve(new Response(null, { status: 202 }));
    };
    const telemetry = new TelemetryClient(randomUUID(), 'b'.repeat(64), {
      surface: 'mcp',
      workspaceRoot: () => '/repo',
      env: {},
      fetcher,
    });
    const server = createServer(createRepositories(openDatabase(':memory:')));
    const [clientTransport, rawServerTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'codex', version: '1.2.3' });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(new TelemetryTransport(rawServerTransport, telemetry)),
    ]);
    try {
      await client.callTool({ name: 'get_work_state' });
      await client.callTool({ name: 'missing_tool' });
    } finally {
      await telemetry.close();
      await client.close();
      await server.close();
    }

    const payload = payloadSchema.parse(JSON.parse(bodies[0] ?? ''));
    expect(payload.source).toEqual({ client_name: 'codex', client_version: '1.2.3' });
    expect(payload.events.map((event) => event.operation)).toEqual([
      null,
      'get_work_state',
      'missing_tool',
    ]);
  });
});
