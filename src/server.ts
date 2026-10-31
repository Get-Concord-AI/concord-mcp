import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Repositories } from './db/index.js';
import type { AgentIdentity } from './domain/identity.js';
import type { TelemetryRecorder } from './telemetry/events.js';
import { CONCORD_SERVER_INSTRUCTIONS } from './install/instructions.js';
import type { AdapterNotice } from './adapter-check.js';
import type { AvailableUpdate } from './update-notifier.js';
import { registerWorkStateResource } from './tools/get-work-state.js';
import { registerWorkflowTools } from './tools/workflow.js';
import { VERSION } from './version.js';
import {
  routedRepositories,
  type WorkspaceContext,
  type WorkspaceManager,
} from './workspaces/manager.js';

/** Concord's advertised MCP server version. */
export const SERVER_VERSION = VERSION;

export interface ServerOptions {
  /** Called after any tool writes to the database (used to regenerate artifacts). */
  onToolWrite?: (workspace: WorkspaceContext | undefined) => void;
  /** Enables automatic root resolution and optional per-operation workspace selection. */
  workspaceManager?: WorkspaceManager;
  /**
   * Who this server's session is, resolved from the environment. When present it
   * is the authority for every write tool, so a model cannot act as a peer by
   * passing that peer's `agent_id`.
   */
  identity?: AgentIdentity;
  /** Reads a background update check without blocking an MCP tool call. */
  getAvailableUpdate?: () => AvailableUpdate | undefined;
  /** Receives whitelisted, content-free results from workflow handlers. */
  telemetry?: TelemetryRecorder;
  /** Reads the background check of this session's harness adapter. */
  getAdapterNotice?: () => AdapterNotice | undefined;
  /** Resolves a harness session from request metadata when it is not in env. */
  requestIdentity?: (meta: Record<string, unknown> | undefined) => AgentIdentity | undefined;
}

/**
 * Build the Concord MCP server and register the workflow tools against the given
 * repositories. Transport wiring lives in the entry points.
 */
export function createServer(repos: Repositories, options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'concord-mcp', version: SERVER_VERSION },
    { instructions: CONCORD_SERVER_INSTRUCTIONS },
  );
  const manager = options.workspaceManager;
  const selectedRepos = manager === undefined ? repos : routedRepositories(manager);
  const selectWorkspace =
    manager === undefined ? undefined : (workspaceId?: string) => manager.select(workspaceId);
  // Register the read surface first so we get the change-notifier, then run it
  // (plus the caller's hook) after every write.
  const notifyWorkStateChanged = registerWorkStateResource(server, selectedRepos, selectWorkspace);
  const onWrite = (workspace?: WorkspaceContext): void => {
    options.onToolWrite?.(workspace ?? manager?.current());
    notifyWorkStateChanged();
  };
  registerWorkflowTools(
    server,
    selectedRepos,
    onWrite,
    selectWorkspace,
    options.identity,
    options.getAvailableUpdate,
    undefined,
    options.telemetry,
    options.getAdapterNotice,
    options.requestIdentity,
  );
  return server;
}
