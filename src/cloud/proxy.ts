import { existsSync, realpathSync } from 'node:fs';
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
import { bearerFor, type Bearer } from './tokens.js';
import { assertKeySafeUrl, sameApi } from './client.js';
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
  /** A current bearer token, refreshed as needed; see `cloud/tokens.ts`. */
  readonly bearer: Bearer;
  readonly machineKey: string;
  readonly projectKey: string;
  /** The primary checkout, which holds the link. */
  readonly repoRoot: string;
  /** The checkout this session works in: a linked worktree's own root. */
  readonly checkoutRoot: string;
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
  checkoutRoot: string = repoRoot,
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
  if (!sameApi(credentials.apiUrl, link.apiUrl)) {
    throw new Error(
      `${repoRoot} is linked to ${link.apiUrl}, but this machine is logged in to ` +
        `${credentials.apiUrl}. Log in to the linked API, or link again.`,
    );
  }

  assertKeySafeUrl(credentials.apiUrl);
  return {
    apiUrl: credentials.apiUrl,
    bearer: bearerFor(env, credentials.apiUrl, fetch),
    machineKey,
    projectKey: link.projectKey,
    repoRoot,
    checkoutRoot,
    identity,
  };
}

/** The tools that act as an agent, and so act as this session's. */
const WRITE_TOOLS = new Set(['start_work', 'update_work', 'transfer_work', 'finish_work']);

const toolArguments = z.record(z.string(), z.json());
type ToolArguments = z.infer<typeof toolArguments>;

/** `path` relative to `root`, or undefined when it is not inside it. */
function inside(root: string, path: string): string | undefined {
  const within = relative(root, path);
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return undefined;
  }
  return within.split(sep).join('/');
}

/**
 * An absolute path inside the checkout this session works in, or the primary
 * one, made relative; anything else as given. Tried as written and resolved,
 * so a path through a symlink (`/tmp` on macOS) still matches.
 */
function repoRelative(
  session: Pick<CloudSession, 'repoRoot' | 'checkoutRoot'>,
  path: string,
): string {
  if (!isAbsolute(path)) return path;
  const candidates = existsSync(path) ? [path, realpathSync(path)] : [path];
  for (const root of [session.checkoutRoot, session.repoRoot]) {
    for (const candidate of candidates) {
      const within = inside(root, candidate);
      if (within !== undefined) return within;
    }
  }
  return path;
}

/** A tool call's arguments as the cloud should receive them. */
export function forwardedArguments(
  tool: string,
  args: ToolArguments,
  session: Pick<CloudSession, 'identity' | 'repoRoot' | 'checkoutRoot'>,
): ToolArguments {
  const forwarded: ToolArguments = {};
  for (const [name, value] of Object.entries(args)) {
    forwarded[name] =
      name.endsWith('files') && Array.isArray(value)
        ? value.map((item) => (typeof item === 'string' ? repoRelative(session, item) : item))
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
    const attempt = cloud();
    try {
      return await (await attempt).listTools();
    } catch (error) {
      forget(attempt);
      throw error;
    }
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const attempt = cloud();
    try {
      const { name } = request.params;
      const args = toolArguments.parse(request.params.arguments ?? {});
      return await (
        await attempt
      ).callTool({ name, arguments: forwardedArguments(name, args, session) });
    } catch (error) {
      forget(attempt);
      return failure(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}
