#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { writeArtifacts } from './artifacts/index.js';
import { startBackgroundUpdateCheck } from './update-notifier.js';
import { resolveDefaultOwner } from './config/default-owner.js';
import { resolveRepoRoot } from './config/paths.js';
import { resolveIdentity } from './domain/identity.js';
import { createServer } from './server.js';
import { ensureAgentRegistered } from './tools/register-agent.js';
import { createTelemetryClient } from './telemetry/client.js';
import { TelemetryTransport } from './telemetry/transport.js';
import { VERSION } from './version.js';
import { WorkspaceManager } from './workspaces/manager.js';

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(process.cwd(), process.env);
  const workspaceManager = WorkspaceManager.fromEnvironment(repoRoot, process.env);
  // One server process per session, with the session id in its environment, so
  // this agent's identity is known before the transport connects — and it is the
  // same id the relay CLI derives for the same session.
  const identity = resolveIdentity(process.env);
  if (identity !== undefined) {
    ensureAgentRegistered(workspaceManager.current().repos, identity, repoRoot);
  }
  const updateCheck = startBackgroundUpdateCheck(VERSION, process.env);
  const telemetry = createTelemetryClient({
    surface: 'mcp',
    workspaceRoot: () => workspaceManager.current().repoRoot,
    recordSessionStarted: true,
  });
  const defaultOwner = resolveDefaultOwner(process.env, repoRoot);
  const server = createServer(workspaceManager.current().repos, {
    workspaceManager,
    defaultOwner,
    ...(identity === undefined ? {} : { identity }),
    getAvailableUpdate: updateCheck.getAvailableUpdate,
    ...(telemetry === undefined ? {} : { telemetry }),
    onToolWrite: (workspace) => {
      if (workspace !== undefined) {
        writeArtifacts(workspace.concordPath, workspace.repos);
      }
    },
  });
  const stdio = new StdioServerTransport();
  const transport = telemetry === undefined ? stdio : new TelemetryTransport(stdio, telemetry);
  process.once('beforeExit', () => {
    void telemetry?.close();
  });
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`concord-mcp failed to start: ${String(error)}\n`);
  process.exitCode = 1;
});
