import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { workspaceRootFromId } from '../config/paths.js';
import {
  identityForRequest,
  parseOpenCodeRequestIdentityMetadata,
  type OpenCodeRequestIdentityMetadata,
} from '../domain/identity.js';
import { CONCORD_SERVER_INSTRUCTIONS } from '../install/instructions.js';
import { VERSION } from '../version.js';
import { HttpClientTransport } from './http-transport.js';
import { repoRelative, type CloudSession } from './session.js';
import { cloudProjectKeyForRoot } from './target.js';

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
 * The cloud project a tool call belongs to. A call that names `workspace_id`
 * — the id Concord's hooks and rules hand the agent — is routed by it: the id
 * decodes to a local checkout, whose project is computed exactly as the
 * server's own root would be. Anything else, including an id this machine
 * cannot resolve, stays with the project the server was started for. This is
 * what lets a globally registered server (Cline has no per-project MCP
 * config) reach the project its hook registered rather than wherever the
 * client happened to launch the process.
 */
function projectKeyForArgs(session: CloudSession, args: ToolArguments): string {
  const workspaceId = args['workspace_id'];
  if (typeof workspaceId !== 'string') return session.projectKey;
  try {
    return cloudProjectKeyForRoot(workspaceRootFromId(workspaceId), session.machineKey);
  } catch {
    return session.projectKey;
  }
}

/**
 * The stdio-facing server for cloud mode. It connects lazily, on the first
 * request, and again after a failure, so a cold or briefly unreachable API
 * costs one failed call rather than the whole session. One client per cloud
 * project: a `workspace_id` argument can move a call to another project, and
 * each project's `x-concord-project` header is fixed when its client connects.
 */
export function createCloudProxyServer(
  session: CloudSession,
  connect: (session: CloudSession) => Promise<Client>,
): McpServer {
  const server = new McpServer(
    { name: 'concord-mcp', version: VERSION },
    { instructions: CONCORD_SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );

  // One client per project, shared; dropped whenever a connection or a call
  // through it fails, so the next call connects afresh instead of reusing a
  // broken one. A tool's own error comes back as a result, never as a failure
  // here.
  const clients = new Map<string, Promise<Client>>();
  const forget = (projectKey: string, attempt: Promise<Client>): void => {
    if (clients.get(projectKey) === attempt) clients.delete(projectKey);
  };
  const clientFor = (projectKey: string): Promise<Client> => {
    const existing = clients.get(projectKey);
    if (existing !== undefined) return existing;
    const attempt = connect({ ...session, projectKey });
    clients.set(projectKey, attempt);
    attempt.catch(() => {
      forget(projectKey, attempt);
    });
    return attempt;
  };

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const attempt = clientFor(session.projectKey);
    try {
      return await (await attempt).listTools();
    } catch (error) {
      forget(session.projectKey, attempt);
      throw error;
    }
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name } = request.params;
      const args = toolArguments.parse(request.params.arguments ?? {});
      const projectKey = projectKeyForArgs(session, args);
      const attempt = clientFor(projectKey);
      try {
        const requestMeta = parseOpenCodeRequestIdentityMetadata(request.params._meta);
        return await (
          await attempt
        ).callTool({
          name,
          arguments: forwardedArguments(name, args, session, requestMeta),
        });
      } catch (error) {
        forget(projectKey, attempt);
        throw error;
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}
