import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  cloudSessionFor,
  connectCloud,
  createCloudProxyServer,
  forwardedArguments,
  type CloudSession,
} from '../../src/cloud/proxy.js';
import { ensureMachineKey, writeCredentials, writeLink } from '../../src/cloud/settings.js';

const SESSION_AGENT = { agentId: 'claude-code:aaaa1111', kind: 'claude-code', origin: 'session' };

describe('forwardedArguments', () => {
  const session = { identity: { ...SESSION_AGENT, origin: 'session' as const }, repoRoot: '/repo' };

  it('acts as the session on write tools, whatever agent the model names', () => {
    expect(forwardedArguments('update_work', { agent_id: 'claude-code:peer' }, session)).toEqual({
      agent_id: SESSION_AGENT.agentId,
    });
    expect(forwardedArguments('start_work', { kind: 'codex' }, session)).toEqual({
      agent_id: SESSION_AGENT.agentId,
      kind: 'claude-code',
    });
  });

  it('leaves the agent a read names alone, and every call without a session', () => {
    expect(forwardedArguments('inspect_work', { agent_id: 'claude-code:peer' }, session)).toEqual({
      agent_id: 'claude-code:peer',
    });
    expect(
      forwardedArguments(
        'update_work',
        { agent_id: 'codex:1' },
        { ...session, identity: undefined },
      ),
    ).toEqual({ agent_id: 'codex:1' });
  });

  it('sends file paths relative to the repository', () => {
    const args = { expected_files: ['/repo/src/a.ts', 'src/b.ts', '/elsewhere/c.ts', '/repo'] };
    expect(forwardedArguments('inspect_work', args, session)).toEqual({
      expected_files: ['src/a.ts', 'src/b.ts', '/elsewhere/c.ts', '/repo'],
    });
  });
});

const rpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.object({ protocolVersion: z.string(), arguments: z.json() }).partial().optional(),
});

/**
 * A stand-in for Concord Cloud's `/mcp`: stateless JSON-RPC over HTTP with JSON
 * responses, as the cloud serves it, recording what it receives.
 */
function fakeCloud(): {
  server: Server;
  requests: IncomingHttpHeaders[];
  calls: z.infer<ReturnType<typeof z.json>>[];
} {
  const requests: IncomingHttpHeaders[] = [];
  const calls: z.infer<ReturnType<typeof z.json>>[] = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    requests.push(request.headers);
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const message = rpcRequest.parse(JSON.parse(body));
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-cloud', version: '0.0.0' },
            }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'start_work', inputSchema: { type: 'object' } }] }
            : (calls.push(message.params?.arguments ?? null),
              { content: [{ type: 'text', text: 'started' }] });
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  return { server, requests, calls };
}

describe('the cloud proxy', () => {
  const cloud = fakeCloud();
  let session: CloudSession;
  let client: Client;

  beforeAll(async () => {
    await new Promise<void>((resolve) => cloud.server.listen(0, '127.0.0.1', resolve));
    const { port } = z
      .object({ port: z.number() })
      .parse(cloud.server.address() satisfies AddressInfo | string | null);
    session = {
      apiUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: 'cak_test',
      machineKey: 'machine-1',
      projectKey: 'github.com/acme/app',
      repoRoot: '/repo',
      identity: { agentId: SESSION_AGENT.agentId, kind: 'claude-code', origin: 'session' },
    };
    const proxy = createCloudProxyServer(session, () => connectCloud(session));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverSide);
    client = new Client({ name: 'harness', version: '0.0.0' });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    cloud.server.closeAllConnections();
    await new Promise((resolve) => cloud.server.close(resolve));
  });

  it("lists the cloud's tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['start_work']);
  });

  it('forwards a call as this repository, machine and session', async () => {
    const result = await client.callTool({
      name: 'start_work',
      arguments: { agent_id: 'claude-code:peer', expected_files: ['/repo/src/a.ts'] },
    });
    expect(result.isError).toBeFalsy();
    expect(cloud.calls.at(-1)).toEqual({
      agent_id: SESSION_AGENT.agentId,
      kind: 'claude-code',
      expected_files: ['src/a.ts'],
    });
    expect(cloud.requests.at(-1)).toMatchObject({
      authorization: 'Bearer cak_test',
      'x-concord-project': 'github.com/acme/app',
      'x-concord-machine': 'machine-1',
    });
  });

  it('answers a call with an error the model can read when the cloud is down', async () => {
    const down = createCloudProxyServer(session, () => Promise.reject(new Error('ECONNREFUSED')));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await down.connect(serverSide);
    const harness = new Client({ name: 'harness', version: '0.0.0' });
    await harness.connect(clientSide);

    const result = await harness.callTool({ name: 'start_work', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Concord Cloud could not be reached');
    await harness.close();
  });
});

describe('cloudSessionFor', () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    repo = mkdtempSync(join(tmpdir(), 'concord-repo-'));
    mkdirSync(join(repo, '.git'));
  });
  const credentials = { apiUrl: 'https://api.test', apiKey: 'k' };

  it('is undefined for a repository that is not linked', () => {
    writeCredentials({ HOME: home }, credentials);
    expect(cloudSessionFor(repo, { HOME: home }, undefined)).toBeUndefined();
  });

  it('refuses a linked repository on a machine that cannot reach that cloud', () => {
    writeLink(repo, { apiUrl: 'https://api.test', projectKey: 'github.com/acme/app' });
    expect(() => cloudSessionFor(repo, { HOME: home }, undefined)).toThrow(/not logged in/);
    ensureMachineKey({ HOME: home }, () => 'm');
    writeCredentials({ HOME: home }, { ...credentials, apiUrl: 'https://other.test' });
    expect(() => cloudSessionFor(repo, { HOME: home }, undefined)).toThrow(/logged in to/);
  });

  it('combines the login, the machine and the link', () => {
    writeCredentials({ HOME: home }, credentials);
    ensureMachineKey({ HOME: home }, () => 'm');
    writeLink(repo, { apiUrl: 'https://api.test', projectKey: 'github.com/acme/app' });
    expect(cloudSessionFor(repo, { HOME: home }, undefined)).toEqual({
      ...credentials,
      machineKey: 'm',
      projectKey: 'github.com/acme/app',
      repoRoot: repo,
      identity: undefined,
    });
  });
});
