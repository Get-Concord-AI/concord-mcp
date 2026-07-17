#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { writeArtifacts } from './artifacts/index.js';
import { concordDir, databasePath, findRepoRoot } from './config/paths.js';
import { openRepositories } from './db/index.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const repoRoot = findRepoRoot(process.cwd());
  const repos = openRepositories(databasePath(repoRoot));
  const artifactsDir = concordDir(repoRoot);
  const server = createServer(repos, {
    onToolWrite: () => {
      writeArtifacts(artifactsDir, repos);
    },
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`concord-mcp failed to start: ${String(error)}\n`);
  process.exitCode = 1;
});
