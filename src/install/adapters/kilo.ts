import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import {
  kiloConfigDir,
  kiloConfigHome,
  kiloMcpState,
  installKiloMcpConfig,
} from '../kilo-config.js';
import type { AdapterReport } from './index.js';
import { atLeast, executablePath, run, versionTuple } from './probe.js';

/**
 * Whether this Kilo's `kilo mcp add` supports the non-interactive
 * `--env … -- command` form setup relies on. Kilo 7.2.x ships the subcommand
 * but an interactive `add`, so the help text is the feature probe.
 */
function supportsKiloMcpAdd(executable: string, env: NodeJS.ProcessEnv): boolean {
  const help = run(executable, ['mcp', 'add', '--help'], env);
  return help.ok && help.output.includes('--env');
}

/** Where Kilo keeps its config, for messages that would otherwise guess `~/.config/kilo`. */
function kiloConfigDescription(env: NodeJS.ProcessEnv): string {
  const dir = kiloConfigDir(env);
  return dir === undefined
    ? kiloConfigHome(env)
    : `${kiloConfigHome(env)} and ${dir} (KILO_CONFIG_DIR)`;
}

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
  if (!supportsKiloMcpAdd(executable, env)) {
    return {
      ...base,
      detected: true,
      status: 'unsupported_version',
      capabilities: [],
      detail:
        'This Kilo CLI cannot register MCP servers non-interactively (`kilo mcp add` lacks `--env`). Upgrade Kilo and re-run concord setup.',
    };
  }
  const mcp = kiloMcpState(env);
  if (mcp.state === 'unreadable') {
    return {
      ...base,
      detected: true,
      status: 'action_required',
      capabilities: [],
      detail: `A Kilo config file under ${kiloConfigDescription(env)} exists but could not be read. Check the file and its permissions.`,
    };
  }
  if (mcp.state === 'conflict') {
    return {
      ...base,
      detected: true,
      status: 'action_required',
      capabilities: [],
      detail: `A "concord" MCP entry Concord did not write exists in ${mcp.path ?? 'a Kilo config file'}; remove or rename it, then re-run concord setup.`,
    };
  }
  if (mcp.state === 'disabled') {
    return {
      ...base,
      detected: true,
      status: 'action_required',
      capabilities: [],
      detail: `Concord's Kilo MCP entry is disabled (enabled: false) in ${mcp.path ?? 'a Kilo config file'}; re-enable it for Concord to receive messages.`,
    };
  }
  const installed = mcp.state === 'installed';
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
  if (!supportsKiloMcpAdd(executable, env)) return;
  installKiloMcpConfig(executable, env);
}
