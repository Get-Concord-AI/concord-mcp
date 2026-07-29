#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { writeArtifacts } from './artifacts/index.js';
import { resolveRepoRoot } from './config/paths.js';
import { createServer } from './server.js';
import { createTelemetryClient } from './telemetry/client.js';
import { TelemetryTransport } from './telemetry/transport.js';
import { WorkspaceManager } from './workspaces/manager.js';

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(process.cwd(), process.env);
  const workspaceManager = WorkspaceManager.fromEnvironment(repoRoot, process.env);
  const server = createServer(workspaceManager.current().repos, {
    workspaceManager,
    onToolWrite: (workspace) => {
      if (workspace !== undefined) {
        writeArtifacts(workspace.concordPath, workspace.repos);
      }
    },
  });
  const telemetry = createTelemetryClient({
    surface: 'mcp',
    workspaceRoot: () => workspaceManager.current().repoRoot,
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
