#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startBackgroundAdapterCheck } from './adapter-check.js';
import { cloudSessionFor, connectCloud, createCloudProxyServer } from './cloud/proxy.js';
import { LOCAL_SESSION_LINKED_MESSAGE, linkedMachine } from './cloud/target.js';
import { resolveCheckoutRoot, resolveRepoRoot } from './config/paths.js';
import { resolveOpenCodeRequestIdentity, resolveServerIdentity } from './domain/identity.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(process.cwd(), process.env);
  // One server process per session, with the session id in its environment, so
  // this agent's identity is known before the transport connects — and it is the
  // same id the relay CLI derives for the same session.
  const identity = resolveServerIdentity(process.env);
  // OpenCode passes its session id on each MCP request, not in the environment.
  const requestIdentity =
    process.env['CONCORD_AGENT_KIND']?.trim() === 'opencode'
      ? resolveOpenCodeRequestIdentity
      : undefined;

  // A machine linked to Concord Cloud works through it everywhere: no local
  // database, and no telemetry from this package for operations that are not local.
  const cloud = cloudSessionFor(
    repoRoot,
    process.env,
    identity,
    resolveCheckoutRoot(process.cwd(), process.env),
    requestIdentity,
  );
  // Adapter repair is an independent child command and runs in either mode.
  const adapterCheck = startBackgroundAdapterCheck(identity, process.env);
  if (cloud !== undefined) {
    const proxy = createCloudProxyServer(
      cloud,
      () => connectCloud(cloud),
      () => linkedMachine(process.env) !== undefined,
    );
    await proxy.connect(new StdioServerTransport());
    return;
  }

  // Keep the local workspace graph out of the Cloud path above. In
  // particular, the workspace database layer loads better-sqlite3's native
  // binding, which is unnecessary when every operation is proxied.
  const [
    { writeArtifacts },
    { startBackgroundUpdateCheck },
    { createServer },
    { ensureAgentRegistered },
    { createTelemetryClient },
    { TelemetryTransport: telemetryTransport },
    { hasExplicitRepoRoot, joinClientRoot },
    { WorkspaceManager: workspaceManagerConstructor },
  ] = await Promise.all([
    import('./artifacts/index.js'),
    import('./update-notifier.js'),
    import('./server.js'),
    import('./tools/register-agent.js'),
    import('./telemetry/client.js'),
    import('./telemetry/transport.js'),
    import('./workspaces/client-roots.js'),
    import('./workspaces/manager.js'),
  ]);
  const workspaceManager = workspaceManagerConstructor.fromEnvironment(repoRoot, process.env, {
    // Started unlinked, this server outlives a later `cloud login`. From then
    // on it neither opens nor uses a local store, which no cloud agent could reach.
    refuseOpen: () =>
      linkedMachine(process.env) === undefined ? undefined : LOCAL_SESSION_LINKED_MESSAGE,
  });
  if (identity !== undefined) {
    ensureAgentRegistered(workspaceManager.current().repos, identity, repoRoot);
  }
  const updateCheck = startBackgroundUpdateCheck(VERSION, process.env);
  const telemetry = createTelemetryClient({
    surface: 'mcp',
    workspaceRoot: () => workspaceManager.activeRoot,
    recordSessionStarted: true,
  });
  const server = createServer(workspaceManager.current().repos, {
    workspaceManager,
    ...(identity === undefined ? {} : { identity }),
    ...(requestIdentity === undefined ? {} : { requestIdentity }),
    getAvailableUpdate: updateCheck.getAvailableUpdate,
    getAdapterNotice: adapterCheck.getNotice,
    ...(telemetry === undefined ? {} : { telemetry }),
    onToolWrite: (workspace) => {
      if (workspace !== undefined) {
        writeArtifacts(workspace.concordPath, workspace.repos);
      }
    },
  });
  if (!hasExplicitRepoRoot(process.env)) {
    // Nothing names the repository, so this server may have been started far
    // from it; ask the client which folder it has open.
    server.server.oninitialized = () => {
      joinClientRoot(server.server, workspaceManager)
        .then((joined) => {
          if (joined !== undefined && identity !== undefined) {
            ensureAgentRegistered(workspaceManager.current().repos, identity, joined.repoRoot);
          }
        })
        .catch(() => {
          // The working directory stays the workspace, as before.
        });
    };
  }
  const stdio = new StdioServerTransport();
  const transport = telemetry === undefined ? stdio : new telemetryTransport(stdio, telemetry);
  process.once('beforeExit', () => {
    void telemetry?.close();
  });
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`concord-mcp failed to start: ${String(error)}\n`);
  process.exitCode = 1;
});
