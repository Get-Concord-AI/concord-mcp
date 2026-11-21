import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  identityForRequest,
  parseOpenCodeRequestIdentityMetadata,
  type OpenCodeRequestIdentityMetadata,
} from '../domain/identity.js';
import { CONCORD_SERVER_INSTRUCTIONS } from '../install/instructions.js';
import { VERSION } from '../version.js';
import { HttpClientTransport } from './http-transport.js';
import { repoRelative, type CloudSession } from './session.js';
import { CLOUD_SESSION_UNLINKED_MESSAGE, linkedMachine } from './target.js';

export { cloudSessionFor, repoRelative, type CloudSession } from './session.js';

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

/** The tools that act as an agent, and so act as this session's. */
const WRITE_TOOLS = new Set(['start_work', 'update_work', 'transfer_work', 'finish_work']);

const toolArguments = z.record(z.string(), z.json());
type ToolArguments = z.infer<typeof toolArguments>;

/** A tool call's arguments as the cloud should receive them. */
export function forwardedArguments(
  tool: string,
  args: ToolArguments,
  session: Pick<CloudSession, 'identity' | 'repoRoot' | 'checkoutRoot' | 'requestIdentity'>,
  requestMeta?: OpenCodeRequestIdentityMetadata,
): ToolArguments {
  const forwarded: ToolArguments = {};
  for (const [name, value] of Object.entries(args)) {
    forwarded[name] =
      name.endsWith('files') && Array.isArray(value)
        ? value.map((item) => (typeof item === 'string' ? repoRelative(session, item) : item))
        : value;
  }

  // The session is the authority, as `resolveActorId` makes it locally.
  const identity = identityForRequest(session.identity, session.requestIdentity?.(requestMeta));
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
      'x-concord-project': session.projectKey,
      'x-concord-machine': session.machineKey,
    },
    // The token is fetched per request, so a long session is never sent with
    // one that has expired since it connected.
    async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${await session.bearer()}`);
      return (fetchImpl ?? fetch)(input, { ...init, headers });
    },
  );
  const client = new Client({ name: 'concord-mcp', version: VERSION });
  await client.connect(transport);
  return client;
}

function failure(reason: string): CallToolResult {
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
  /**
   * False after `concord cloud unlink`. The default re-reads the machine link
   * so a proxy started while linked stops forwarding once the machine is not.
   */
  stillLinked: () => boolean = () => linkedMachine(process.env) !== undefined,
): McpServer {
  const server = new McpServer(
    { name: 'concord-mcp', version: VERSION },
    { instructions: CONCORD_SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );

  // One client, shared; dropped whenever a connection or a call through it
  // fails, so the next call connects afresh instead of reusing a broken one.
  // A tool's own error comes back as a result, never as a failure here.
  let pending: Promise<Client> | undefined;
  const forget = (attempt: Promise<Client>): void => {
    if (pending === attempt) pending = undefined;
  };
  const cloud = (): Promise<Client> => {
    if (pending === undefined) {
      const attempt = connect();
      pending = attempt;
      attempt.catch(() => {
        forget(attempt);
      });
    }
    return pending;
  };

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!stillLinked()) throw new Error(CLOUD_SESSION_UNLINKED_MESSAGE);
    const attempt = cloud();
    try {
      return await (await attempt).listTools();
    } catch (error) {
      forget(attempt);
      throw error;
    }
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!stillLinked()) {
      return {
        isError: true,
        content: [{ type: 'text', text: CLOUD_SESSION_UNLINKED_MESSAGE }],
      };
    }
    const attempt = cloud();
    try {
      const { name } = request.params;
      const args = toolArguments.parse(request.params.arguments ?? {});
      const requestMeta = parseOpenCodeRequestIdentityMetadata(request.params._meta);
      return await (
        await attempt
      ).callTool({
        name,
        arguments: forwardedArguments(name, args, session, requestMeta),
      });
    } catch (error) {
      forget(attempt);
      return failure(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}
