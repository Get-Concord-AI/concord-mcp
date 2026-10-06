import { isAbsolute, relative, sep } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { AgentIdentity } from '../domain/identity.js';
import { CONCORD_SERVER_INSTRUCTIONS } from '../install/instructions.js';
import { VERSION } from '../version.js';
import { HttpClientTransport } from './http-transport.js';
import { assertKeySafeUrl } from './client.js';
import { readCredentials, readLink, readMachineKey } from './settings.js';

/**
 * Cloud mode for the MCP server: in a linked repository, `concord-mcp` forwards
 * the workflow tools to Concord Cloud instead of answering from SQLite.
 *
 * A proxy rather than pointing the harness at the cloud URL, because only this
 * process can see the session: it stamps the session's own agent onto every
 * write, as the local server does, so a model cannot act as a peer. It also
 * keeps the API key out of committed MCP config, and sends file paths relative
 * to the repository, the only form the cloud accepts.
 *
 * Proxied calls are not recorded by this package's telemetry: they are not
 * local operations, and Concord Cloud records its own usage.
 */

export interface CloudSession {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly machineKey: string;
  readonly projectKey: string;
  readonly repoRoot: string;
  readonly identity: AgentIdentity | undefined;
}

/**
 * The cloud session for a repository: undefined when it is not linked, so
 * Concord stays local. A link this machine cannot use is an error rather than a
 * silent fall back to local state, which no other agent would see.
 */
export function cloudSessionFor(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  identity: AgentIdentity | undefined,
): CloudSession | undefined {
  const link = readLink(repoRoot);
  if (link === undefined) return undefined;

  const credentials = readCredentials(env);
  const machineKey = readMachineKey(env);
  if (credentials === undefined || machineKey === undefined) {
    throw new Error(
      `${repoRoot} is linked to Concord Cloud, but this machine is not logged in. ` +
        'Run `concord cloud login`, or `concord cloud unlink` to work locally.',
    );
  }
  if (credentials.apiUrl !== link.apiUrl) {
    throw new Error(
      `${repoRoot} is linked to ${link.apiUrl}, but this machine is logged in to ` +
        `${credentials.apiUrl}. Log in to the linked API, or link again.`,
    );
  }

  assertKeySafeUrl(credentials.apiUrl);
  return { ...credentials, machineKey, projectKey: link.projectKey, repoRoot, identity };
}

/** The tools that act as an agent, and so act as this session's. */
const WRITE_TOOLS = new Set(['start_work', 'update_work', 'transfer_work', 'finish_work']);

const toolArguments = z.record(z.string(), z.json());
type ToolArguments = z.infer<typeof toolArguments>;

/** An absolute path inside the repository, made relative; anything else as given. */
function repoRelative(repoRoot: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(repoRoot, path);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return path;
  return inside.split(sep).join('/');
}

/** A tool call's arguments as the cloud should receive them. */
export function forwardedArguments(
  tool: string,
  args: ToolArguments,
  session: Pick<CloudSession, 'identity' | 'repoRoot'>,
): ToolArguments {
  const forwarded: ToolArguments = {};
  for (const [name, value] of Object.entries(args)) {
    forwarded[name] =
      name.endsWith('files') && Array.isArray(value)
        ? value.map((item) =>
            typeof item === 'string' ? repoRelative(session.repoRoot, item) : item,
          )
        : value;
  }

  // The session is the authority, as `resolveActorId` makes it locally.
  const identity = session.identity;
  if (identity !== undefined && WRITE_TOOLS.has(tool)) {
    forwarded['agent_id'] = identity.agentId;
    if (tool === 'start_work') forwarded['kind'] = identity.kind;
  }
  return forwarded;
}

/** Opens an MCP client session with the cloud's `/mcp`, as this repository and machine. */
export async function connectCloud(session: CloudSession, fetchImpl?: FetchLike): Promise<Client> {
  const transport = new HttpClientTransport(
    new URL(`${session.apiUrl.replace(/\/+$/, '')}/mcp`),
    {
      Authorization: `Bearer ${session.apiKey}`,
      'x-concord-project': session.projectKey,
      'x-concord-machine': session.machineKey,
    },
    fetchImpl,
  );
  const client = new Client({ name: 'concord-mcp', version: VERSION });
  await client.connect(transport);
  return client;
}

function failure(error: unknown): CallToolResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `Concord Cloud could not be reached: ${reason}` }],
  };
}

/**
 * The stdio-facing server for cloud mode. It connects lazily, on the first
 * request, and again after a failure, so a cold or briefly unreachable API
 * costs one failed call rather than the whole session.
 */
export function createCloudProxyServer(
  session: CloudSession,
  connect: () => Promise<Client>,
): McpServer {
  const server = new McpServer(
    { name: 'concord-mcp', version: VERSION },
    { instructions: CONCORD_SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );

  let pending: Promise<Client> | undefined;
  const cloud = (): Promise<Client> => {
    pending ??= connect().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };

  server.server.setRequestHandler(ListToolsRequestSchema, async () => (await cloud()).listTools());

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name } = request.params;
      const args = toolArguments.parse(request.params.arguments ?? {});
      const result = await (
        await cloud()
      ).callTool({ name, arguments: forwardedArguments(name, args, session) });
      return result;
    } catch (error) {
      return failure(error);
    }
  });

  return server;
}
