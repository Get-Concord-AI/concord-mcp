import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import { kiloMcpInstalled, installKiloMcpConfig } from '../kilo-config.js';
import type { AdapterReport } from './index.js';
import { atLeast, executablePath, run, versionTuple } from './probe.js';

/**
 * Kilo CLI's adapter status. Delivery is busy-only pull through the durable
 * inbox — Kilo exposes no session identity or idle wake-up Concord can
 * verify — so an installed Kilo never reports idle reachability.
 */
export function statusKilo(executable: string | undefined, env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS.kilo;
  const base = { harness: config.name, monitor: config.monitor.kind };
  if (executable === undefined) {
    return {
      ...base,
      detected: false,
      status: 'not_detected',
      capabilities: [],
      detail: 'Kilo CLI was not found on PATH.',
    };
  }
  const version = versionTuple(run(executable, ['--version'], env).output);
  if (version === undefined || !atLeast(version, config.minimumVersion)) {
    return {
      ...base,
      detected: true,
      status: 'unsupported_version',
      capabilities: [],
      detail: config.unsupportedDetail,
    };
  }
  // The `mcp` subcommand is the whole integration surface; older releases may
  // lack it even when their version number passes the floor.
  if (!run(executable, ['mcp', '--help'], env).ok) {
    return {
      ...base,
      detected: true,
      status: 'unsupported_version',
      capabilities: [],
      detail: 'This Kilo CLI has no `kilo mcp` subcommand for MCP registration.',
    };
  }
  const installed = kiloMcpInstalled(env);
  if (installed === 'unreadable') {
    return {
      ...base,
      detected: true,
      status: 'action_required',
      capabilities: [],
      detail:
        'A Kilo config file under ~/.config/kilo exists but could not be read. Check the file and its permissions.',
    };
  }
  return {
    ...base,
    detected: true,
    status: installed ? 'installed' : 'action_required',
    capabilities: installed ? [...config.installedCapabilities] : [],
    detail: installed
      ? config.installedDetail
      : 'Kilo CLI needs the Concord MCP server registered with `kilo mcp add`.',
  };
}

/** Register Concord with Kilo CLI when a supported Kilo is present; throws on failure. */
export function installKilo(env: NodeJS.ProcessEnv): void {
  const executable = executablePath(HARNESS_CONFIGS.kilo.executable, env);
  if (executable === undefined) return;
  const version = versionTuple(run(executable, ['--version'], env).output);
  if (version === undefined || !atLeast(version, HARNESS_CONFIGS.kilo.minimumVersion)) return;
  if (!run(executable, ['mcp', '--help'], env).ok) return;
  installKiloMcpConfig(executable, env);
}
