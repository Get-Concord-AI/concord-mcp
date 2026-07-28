#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { writeArtifacts } from './artifacts/index.js';
import { concordDir, databasePath, resolveRepoRoot } from './config/paths.js';
import { openRepositories } from './db/index.js';
import { createServer } from './server.js';
import { createTelemetryClient } from './telemetry/client.js';
import { TelemetryTransport } from './telemetry/transport.js';

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(process.cwd(), process.env);
  const repos = openRepositories(databasePath(repoRoot));
  const artifactsDir = concordDir(repoRoot);
  const server = createServer(repos, {
    onToolWrite: () => {
      writeArtifacts(artifactsDir, repos);
    },
  });
  const telemetry = createTelemetryClient({
    surface: 'mcp',
    workspaceRoot: () => repoRoot,
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
